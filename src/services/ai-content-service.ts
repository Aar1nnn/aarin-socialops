import { CapabilityStatus, ContentStatus, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import type { AiContentStageAdapter, AiPipelineContext } from "../lib/ai-content-contracts";
import { getAiContentStageAdapter } from "../lib/adapters/ai-content";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { buildBrandContext } from "./brand-service";
import { buildContentMemory, buildPerformanceMemory, buildResearchMemory } from "./memory-service";

const pipelineInputSchema = z.object({ intent: z.string().trim().min(1).max(2000) });

export async function buildAiPipelineContext(context: RequestContext, contentItemId: string): Promise<AiPipelineContext> {
  const item = await db.contentItem.findFirst({
    where: { id: contentItemId, clientId: context.clientId },
    include: {
      plan: { include: { product: { include: { fields: true } } } },
      account: true,
    },
  });
  if (!item) throw new AppError("Content item not found.", 404, "CONTENT_NOT_FOUND");
  const [brand, contentMemory, performanceMemory, researchMemory, policy] = await Promise.all([
    buildBrandContext(context),
    buildContentMemory(context),
    buildPerformanceMemory(context),
    buildResearchMemory(context),
    db.platformPolicy.findUnique({ where: { clientId_platform: { clientId: context.clientId, platform: item.platform } } }),
  ]);
  const confirmedFacts = (item.plan.product?.fields || [])
    .filter((field) => field.status === "CONFIRMED" && field.value?.trim() && field.source?.trim())
    .map((field) => ({ key: field.key, value: field.value!.trim(), source: field.source!.trim() }));
  const missingFactKeys = (item.plan.product?.fields || [])
    .filter((field) => field.status !== "CONFIRMED" || !field.value?.trim() || !field.source?.trim())
    .map((field) => field.key);
  return {
    clientId: context.clientId,
    contentItemId: item.id,
    currentVersionId: item.currentVersionId,
    platform: item.platform,
    objective: item.plan.objective,
    theme: item.plan.theme,
    brand,
    product: item.plan.product ? { id: item.plan.product.id, name: item.plan.product.name, dataVersion: item.plan.product.dataVersion } : null,
    confirmedFacts,
    missingFactKeys,
    contentMemory,
    performanceMemory,
    researchMemory,
    maxTextLength: policy?.maxTextLength ?? null,
  };
}

export async function runAiContentPipeline(
  context: RequestContext,
  contentItemId: string,
  raw: unknown,
  injectedAdapter?: AiContentStageAdapter,
) {
  assertCanWrite(context);
  const input = pipelineInputSchema.parse(raw);
  const [pipelineContext, integration] = await Promise.all([
    buildAiPipelineContext(context, contentItemId),
    db.integrationConfig.findFirst({
      where: { clientId: context.clientId, type: "TEXT_GENERATION", status: CapabilityStatus.VERIFIED },
      orderBy: { verifiedAt: "desc" },
    }),
  ]);
  const adapter = injectedAdapter || getAiContentStageAdapter(integration?.provider);
  const strategy = await adapter.strategy(pipelineContext, input.intent);
  const draft = await adapter.generate(pipelineContext, strategy);
  const confirmedKeys = new Set(pipelineContext.confirmedFacts.map((fact) => fact.key));
  const unconfirmedUsedKeys = draft.usedFactKeys.filter((key) => !confirmedKeys.has(key));
  if (unconfirmedUsedKeys.length) {
    throw new AppError(`AI used unconfirmed fact keys: ${unconfirmedUsedKeys.join(", ")}`, 422, "AI_UNCONFIRMED_FACT_USED");
  }
  const review = await adapter.review(pipelineContext, strategy, draft);
  const humanized = await adapter.humanize(pipelineContext, draft, review);
  const shortened = await adapter.shorten(pipelineContext, humanized);
  if (pipelineContext.maxTextLength && shortened.text.length > pipelineContext.maxTextLength) {
    throw new AppError("AI shortener did not satisfy the platform length limit.", 422, "AI_TEXT_TOO_LONG");
  }
  const prompt = await db.promptVersion.findFirst({
    where: { clientId: context.clientId, active: true, capability: { in: ["ai_content_pipeline", "multi_platform_content"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!prompt) throw new AppError("No active AI content prompt contract is configured.", 409, "PROMPT_VERSION_MISSING");

  return db.$transaction(async (tx) => {
    const live = await tx.contentItem.findFirst({
      where: { id: contentItemId, clientId: context.clientId },
      select: { id: true, status: true, currentVersionId: true, plan: { select: { product: { select: { id: true, dataVersion: true } } } } },
    });
    if (!live) throw new AppError("Content item not found.", 404, "CONTENT_NOT_FOUND");
    if (live.status === ContentStatus.RUNNING) throw new AppError("Publishing has started; AI cannot replace this version.", 409, "PUBLISH_IN_PROGRESS");
    if (live.currentVersionId !== pipelineContext.currentVersionId
      || live.plan.product?.id !== pipelineContext.product?.id
      || live.plan.product?.dataVersion !== pipelineContext.product?.dataVersion) {
      throw new AppError("Content or product facts changed while AI was running. Refresh and try again.", 409, "STALE_OPERATION");
    }
    const latest = await tx.contentVersion.aggregate({ where: { contentItemId }, _max: { version: true } });
    const version = await tx.contentVersion.create({
      data: {
        clientId: context.clientId,
        contentItemId,
        version: (latest._max.version ?? 0) + 1,
        text: shortened.text,
        title: draft.title,
        productDataVersion: pipelineContext.product?.dataVersion ?? null,
        promptVersionId: prompt.id,
        generator: adapter.name,
        simulated: adapter.simulated,
        generationLabel: adapter.simulated ? "模拟 AI Pipeline" : "AI Pipeline",
        sourceFacts: {
          confirmedFacts: pipelineContext.confirmedFacts,
          missingFields: pipelineContext.missingFactKeys,
          usedFactKeys: draft.usedFactKeys,
          strategy,
          stages: ["strategy", "generator", "reviewer", "humanizer", "shortener"],
        },
      },
    });
    if (live.currentVersionId) {
      await tx.publishJob.updateMany({
        where: {
          clientId: context.clientId,
          contentVersionId: live.currentVersionId,
          status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
        },
        data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "SUPERSEDED_BY_AI_VERSION" },
      });
    }
    await tx.aiContentReview.create({
      data: {
        clientId: context.clientId,
        contentVersionId: version.id,
        verdict: review.verdict,
        score: review.score,
        issues: review.issues,
        reviewer: adapter.name,
        metadata: { simulated: adapter.simulated, advisoryOnly: true },
      },
    });
    await tx.contentItem.update({
      where: { id: contentItemId },
      data: { currentVersionId: version.id, status: ContentStatus.DRAFT, scheduledAt: null },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "AI_CONTENT_VERSION_CREATED",
        entityType: "ContentVersion",
        entityId: version.id,
        metadata: { reviewVerdict: review.verdict, simulated: adapter.simulated },
      },
    });
    return { version, review, strategy, approvalRequired: true, publishJobCreated: false };
  });
}
