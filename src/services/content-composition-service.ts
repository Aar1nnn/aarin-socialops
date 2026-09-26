import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { TextGenerationAdapter } from "../lib/adapters/types";
import { getTextGenerationAdapter } from "../lib/adapters/text-generation";
import type { RequestContext } from "../lib/context";
import { assertCanWrite } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { editContentVersion } from "./content-service";
import { prepareAIContentPipelineInput, runPreparedAIContentPipeline } from "./ai-content-pipeline-service";
import { releaseUsage, reserveUsage, settleUsage } from "./usage-service";
import { resolveStrategyForComposition, strategyModelContext, strategyProvenanceFacts } from "./social-strategy-service";

const supportedPlatforms = ["facebook", "instagram", "tiktok", "linkedin"] as const;

const expectedVersionSchema = z.object({
  expectedVersionId: z.string().min(1),
  instruction: z.string().trim().max(2000).optional(),
});

const rewriteSchema = expectedVersionSchema.extend({
  action: z.enum(["rewrite", "shorten", "expand", "professionalize", "humanize", "change_cta", "change_hook"]),
  selection: z.object({ start: z.number().int().min(0), end: z.number().int().positive() }).optional(),
}).superRefine((value, ctx) => {
  if (value.selection && value.selection.end <= value.selection.start) {
    ctx.addIssue({ code: "custom", path: ["selection"], message: "Selection end must be greater than start." });
  }
});

const draftUpdateSchema = z.object({
  expectedVersionId: z.string().min(1),
  title: z.string().trim().max(200).nullable().optional(),
  text: z.string().min(1).max(100_000),
  assetIds: z.array(z.string().min(1)).max(100).optional(),
  accountId: z.string().min(1).optional(),
  reason: z.string().trim().max(500).optional(),
});

const restoreSchema = z.object({
  versionId: z.string().min(1),
  expectedVersionId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Prisma.JsonObject : {};
}

async function getCompositionItem(context: RequestContext, contentItemId: string) {
  const item = await db.contentItem.findFirst({
    where: { id: contentItemId, clientId: context.clientId },
    include: {
      account: true,
      plan: { include: { product: { include: { fields: true } } } },
      currentVersion: { include: { assetLinks: true } },
    },
  });
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  if (!item.plan.product) throw new AppError("内容没有关联产品，无法构建可验证的产品上下文。", 409, "PRODUCT_CONTEXT_REQUIRED");
  if (!supportedPlatforms.includes(item.platform as (typeof supportedPlatforms)[number])) {
    throw new AppError("当前平台尚不支持内容生成。", 409, "PLATFORM_NOT_SUPPORTED");
  }
  return item;
}

async function generateVariant(
  context: RequestContext,
  contentItemId: string,
  input: z.infer<typeof expectedVersionSchema> & { action: string; selection?: { start: number; end: number } },
  adapterOverride?: TextGenerationAdapter,
) {
  const item = await getCompositionItem(context, contentItemId);
  if (item.currentVersion!.id !== input.expectedVersionId) {
    throw new AppError("内容已被其他操作更新，请刷新后重试。", 409, "VERSION_CONFLICT");
  }
  const [client, prompt, textIntegration, policy] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.promptVersion.findFirst({
      where: { clientId: context.clientId, capability: "multi_platform_content", active: true },
      orderBy: { createdAt: "desc" },
    }),
    db.integrationConfig.findFirst({
      where: { clientId: context.clientId, type: "TEXT_GENERATION", status: "VERIFIED" },
      orderBy: { verifiedAt: "desc" },
    }),
    db.platformPolicy.findUnique({ where: { clientId_platform: { clientId: context.clientId, platform: item.platform } } }),
  ]);
  if (!prompt) throw new AppError("内容生成 prompt 未配置。", 500, "PROMPT_NOT_CONFIGURED");
  const strategyBinding = await resolveStrategyForComposition(context.clientId, client.mode, item.plan.socialStrategyId);
  const socialStrategy = strategyModelContext(strategyBinding);
  const confirmedFacts = item.plan.product!.fields
    .filter((field) => field.status === "CONFIRMED" && field.value)
    .map((field) => ({ key: field.key, value: field.value!, source: field.source || "未记录来源" }));
  const missingFields = item.plan.product!.fields
    .filter((field) => field.status !== "CONFIRMED" || !field.value)
    .map((field) => field.key);
  const currentText = input.selection
    ? item.currentVersion!.text.slice(input.selection.start, input.selection.end)
    : item.currentVersion!.text;
  const pipelineInput = await prepareAIContentPipelineInput(context, {
    clientName: client.name,
    mode: client.mode,
    targetMarkets: socialStrategy?.targetMarkets ?? client.targetMarkets,
    productFocus: client.productFocus,
    brandGuidelines: client.brandGuidelines,
    productName: item.plan.product!.name,
    objective: `Composition action: ${input.action}. ${input.instruction || "Preserve verified facts and intent."}\nCurrent content:\n${currentText}`,
    theme: item.plan.theme,
    confirmedFacts,
    missingFields,
    platforms: [item.platform as (typeof supportedPlatforms)[number]],
    instruction: prompt.instruction,
  }, socialStrategy);
  const configuredProvider = textIntegration?.provider === "openai-compatible" ? "openai-compatible" : "mock";
  const adapter = adapterOverride || getTextGenerationAdapter(configuredProvider);
  const reservation = !adapterOverride && configuredProvider === "openai-compatible"
    ? await reserveUsage({
        clientId: context.clientId,
        capability: "content_composition",
        provider: configuredProvider,
        units: Math.ceil(JSON.stringify(pipelineInput).length / 4) + Number(process.env.TEXT_MODEL_MAX_OUTPUT_UNITS || 2000),
      })
    : null;
  try {
    const generated = await runPreparedAIContentPipeline(
      pipelineInput,
      adapter,
      { [item.platform]: policy?.maxTextLength ?? null },
    );
    const draft = generated.output.drafts.find((candidate) => candidate.platform === item.platform);
    if (!draft) throw new AppError("模型未返回目标平台版本。", 502, "INCOMPLETE_MODEL_OUTPUT");
    if (reservation) {
      await settleUsage({
        reservationId: reservation.id,
        clientId: context.clientId,
        model: generated.model,
        inputUnits: generated.usage.inputUnits,
        outputUnits: generated.usage.outputUnits,
      });
    } else {
      await db.usageLog.create({
        data: {
          clientId: context.clientId,
          capability: "content_composition",
          provider: generated.provider,
          model: generated.model,
          inputUnits: generated.usage.inputUnits,
          outputUnits: generated.usage.outputUnits,
          simulated: generated.simulated,
        },
      });
    }
    const existingFacts = jsonObject(item.currentVersion!.sourceFacts);
    return editContentVersion(context, contentItemId, {
      expectedVersionId: input.expectedVersionId,
      text: input.selection
        ? `${item.currentVersion!.text.slice(0, input.selection.start)}${draft.text}${item.currentVersion!.text.slice(input.selection.end)}`
        : draft.text,
      title: draft.title,
      source: input.action === "regenerate_platform" ? "AI_REGENERATE" : "AI_REWRITE",
      reason: input.action.toUpperCase(),
      generator: generated.provider,
      promptVersionId: prompt.id,
      generationLabel: generated.simulated ? "模拟内容改写" : "AI 内容改写",
      sourceFacts: {
        ...existingFacts,
        creationMethod: "AI_COMPOSITION",
        ...strategyProvenanceFacts(strategyBinding),
        compositionAction: input.action,
        confirmedFacts,
        missingFields: draft.missingInformation,
        pipeline: generated.pipeline,
      } as Prisma.InputJsonValue,
      expectedStrategyId: strategyBinding.strategy?.id ?? null,
      expectedClientMode: client.mode,
    });
  } catch (error) {
    if (reservation) await releaseUsage(reservation.id, context.clientId);
    throw error;
  }
}

export async function regeneratePlatformVariant(
  context: RequestContext,
  contentItemId: string,
  raw: unknown,
  adapterOverride?: TextGenerationAdapter,
) {
  assertCanWrite(context);
  const input = expectedVersionSchema.parse(raw);
  return generateVariant(context, contentItemId, { ...input, action: "regenerate_platform" }, adapterOverride);
}

export async function rewriteContent(
  context: RequestContext,
  contentItemId: string,
  raw: unknown,
  adapterOverride?: TextGenerationAdapter,
) {
  assertCanWrite(context);
  const input = rewriteSchema.parse(raw);
  return generateVariant(context, contentItemId, input, adapterOverride);
}

export async function updateDraftContent(context: RequestContext, contentItemId: string, raw: unknown) {
  assertCanWrite(context);
  const input = draftUpdateSchema.parse(raw);
  return editContentVersion(context, contentItemId, {
    ...input,
    source: "AUTOSAVE",
    reason: input.reason || "DRAFT_AUTOSAVE",
    generator: "operator-autosave",
    generationLabel: "草稿保存版本",
  });
}

export async function restoreContentVersion(context: RequestContext, contentItemId: string, raw: unknown) {
  assertCanWrite(context);
  const input = restoreSchema.parse(raw);
  const target = await db.contentVersion.findFirst({
    where: { id: input.versionId, contentItemId, clientId: context.clientId },
    include: { assetLinks: true },
  });
  if (!target) throw new AppError("历史版本不存在或无权访问。", 404, "VERSION_NOT_FOUND");
  return editContentVersion(context, contentItemId, {
    expectedVersionId: input.expectedVersionId,
    previousVersionId: target.id,
    title: target.title,
    text: target.text,
    assetIds: target.assetLinks.map((link) => link.assetId),
    source: "RESTORE",
    reason: input.reason || `RESTORE_VERSION_${target.version}`,
    generator: "version-restore",
    generationLabel: `恢复自 v${target.version}`,
    sourceFacts: target.sourceFacts as Prisma.InputJsonValue,
  });
}

export async function listContentVersions(context: RequestContext, contentItemId: string) {
  const item = await db.contentItem.findFirst({ where: { id: contentItemId, clientId: context.clientId }, select: { id: true } });
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  return db.contentVersion.findMany({
    where: { clientId: context.clientId, contentItemId },
    include: { createdBy: { select: { id: true, displayName: true } }, approvals: { orderBy: { createdAt: "desc" } } },
    orderBy: { version: "desc" },
  });
}

export async function compareContentVersions(context: RequestContext, contentItemId: string, beforeId: string, afterId: string) {
  const versions = await db.contentVersion.findMany({
    where: { clientId: context.clientId, contentItemId, id: { in: [beforeId, afterId] } },
  });
  if (versions.length !== new Set([beforeId, afterId]).size) {
    throw new AppError("比较版本不存在或无权访问。", 404, "VERSION_NOT_FOUND");
  }
  const before = versions.find((version) => version.id === beforeId)!;
  const after = versions.find((version) => version.id === afterId)!;
  const changedFields = (["title", "text", "productDataVersion", "promptVersionId"] as const)
    .filter((field) => before[field] !== after[field]);
  return {
    before: { id: before.id, version: before.version, title: before.title, text: before.text, productDataVersion: before.productDataVersion, promptVersionId: before.promptVersionId },
    after: { id: after.id, version: after.version, title: after.title, text: after.text, productDataVersion: after.productDataVersion, promptVersionId: after.promptVersionId },
    changedFields,
  };
}
