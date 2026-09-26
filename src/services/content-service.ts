import {
  ApprovalDecision,
  CapabilityStatus,
  ClientMode,
  ContentStatus,
  Prisma,
  PublishJobStatus,
} from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { getTextGenerationAdapter } from "../lib/adapters/text-generation";
import type { TextGenerationAdapter } from "../lib/adapters/types";
import { sha256 } from "../lib/security";
import { assertValidTimeZone, zonedLocalDateTimeToUtc } from "../lib/timezone";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { releaseUsage, reserveUsage, settleUsage } from "./usage-service";
import { prepareAIContentPipelineInput, runPreparedAIContentPipeline } from "./ai-content-pipeline-service";
import { getPlatformRegistry, resolveLivePublishingTarget } from "./platform-registry-service";

const platforms = ["facebook", "instagram", "tiktok", "linkedin"] as const;
const generateInputSchema = z.object({
  productId: z.string().min(1),
  theme: z.string().min(1),
  objective: z.string().min(1),
  accountIds: z.array(z.string().min(1)).optional(),
  platforms: z.array(z.enum(platforms)).optional(),
  assetIds: z.array(z.string()).default([]),
  plannedAt: z.coerce.date().optional(),
}).refine((value) => Boolean(value.accountIds?.length || value.platforms?.length), {
  message: "至少选择一个具体账号。",
});

export async function generateContentPlan(context: RequestContext, raw: unknown, adapterOverride?: TextGenerationAdapter) {
  assertCanWrite(context);
  const input = generateInputSchema.parse(raw);
  const requestedAccountIds = input.accountIds ? [...new Set(input.accountIds)] : undefined;
  const product = await db.product.findFirst({
    where: { id: input.productId, clientId: context.clientId },
    include: { fields: true, assetLinks: true },
  });
  if (!product) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
  const assetIds = input.assetIds.length ? input.assetIds : product.assetLinks.map((link) => link.assetId);
  const accessibleAssets = await db.asset.findMany({
    where: { clientId: context.clientId, id: { in: assetIds } },
    select: { id: true },
  });
  if (accessibleAssets.length !== new Set(assetIds).size) {
    throw new AppError("包含不存在或其他客户的素材。", 403, "ASSET_SCOPE_VIOLATION");
  }
  const [client, candidateAccounts, prompt, textIntegration, policies] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.socialAccount.findMany({
      where: requestedAccountIds?.length
        ? { clientId: context.clientId, id: { in: requestedAccountIds } }
        : { clientId: context.clientId, platform: { in: input.platforms } },
    }),
    db.promptVersion.findFirst({
      where: { clientId: context.clientId, capability: "multi_platform_content", active: true },
      orderBy: { createdAt: "desc" },
    }),
    db.integrationConfig.findFirst({
      where: { clientId: context.clientId, type: "TEXT_GENERATION", status: CapabilityStatus.VERIFIED },
      orderBy: { verifiedAt: "desc" },
    }),
    db.platformPolicy.findMany({ where: { clientId: context.clientId } }),
  ]);
  let accounts = candidateAccounts;
  if (requestedAccountIds?.length) {
    if (accounts.length !== requestedAccountIds.length) {
      throw new AppError("包含不存在或其他客户的目标账号。", 403, "ACCOUNT_SCOPE_VIOLATION");
    }
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    accounts = requestedAccountIds.map((id) => accountById.get(id)!);
    if (accounts.some((account) => !account.isSelected)) {
      throw new AppError("目标账号尚未由运营者选择启用。", 409, "ACCOUNT_NOT_SELECTED");
    }
  } else {
    accounts = (input.platforms || []).map((platform) => {
      const matches = candidateAccounts.filter((account) => account.platform === platform && account.isSelected);
      if (matches.length !== 1) {
        throw new AppError(`平台 ${platform} 必须明确选择一个账号，当前可用 ${matches.length} 个。`, 409, "ACCOUNT_TARGET_AMBIGUOUS");
      }
      return matches[0];
    });
  }
  const platformValues = [...new Set(accounts.map((account) => account.platform))];
  if (platformValues.some((platform) => !platforms.includes(platform as (typeof platforms)[number]))) {
    throw new AppError("目标账号的平台尚不支持内容生成。", 409, "PLATFORM_NOT_SUPPORTED");
  }
  const targetPlatforms = platformValues as Array<(typeof platforms)[number]>;
  if (!prompt) throw new AppError("内容生成 prompt 未配置。", 500, "PROMPT_NOT_CONFIGURED");
  const confirmedFacts = product.fields
    .filter((field) => field.status === "CONFIRMED" && field.value)
    .map((field) => ({ key: field.key, value: field.value!, source: field.source || "未记录来源" }));
  const missingFields = product.fields
    .filter((field) => field.status !== "CONFIRMED" || !field.value)
    .map((field) => field.key);
  const configuredProvider = textIntegration?.provider === "openai-compatible" ? "openai-compatible" : "mock";
  const modelInput = {
    clientName: client.name,
    mode: client.mode,
    targetMarkets: client.targetMarkets,
    productFocus: client.productFocus,
    brandGuidelines: client.brandGuidelines,
    productName: product.name,
    objective: input.objective,
    theme: input.theme,
    confirmedFacts,
    missingFields,
    platforms: targetPlatforms,
    instruction: prompt.instruction,
  };
  const pipelineInput = await prepareAIContentPipelineInput(context, modelInput);
  const reservation = configuredProvider === "openai-compatible"
    ? await reserveUsage({ clientId: context.clientId, capability: "multi_platform_content", provider: configuredProvider, units: Math.ceil(JSON.stringify(pipelineInput).length / 4) + Number(process.env.TEXT_MODEL_MAX_OUTPUT_UNITS || 2000) })
    : null;
  let generated;
  try {
    const adapter = adapterOverride || getTextGenerationAdapter(configuredProvider);
    generated = await runPreparedAIContentPipeline(
      pipelineInput,
      adapter,
      Object.fromEntries(policies.map((policy) => [policy.platform, policy.maxTextLength])),
    );
    if (reservation) await settleUsage({ reservationId: reservation.id, clientId: context.clientId, model: generated.model, inputUnits: generated.usage.inputUnits, outputUnits: generated.usage.outputUnits });
  } catch (error) {
    if (reservation) await releaseUsage(reservation.id, context.clientId);
    throw error;
  }
  if (generated.output.drafts.length !== targetPlatforms.length) {
    throw new AppError("生成结果未覆盖全部平台。", 502, "INCOMPLETE_MODEL_OUTPUT");
  }

  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${product.id} AND "clientId" = ${context.clientId} FOR UPDATE`;
    const liveProduct = await tx.product.findFirst({
      where: { id: product.id, clientId: context.clientId },
      select: { dataVersion: true },
    });
    if (!liveProduct || liveProduct.dataVersion !== product.dataVersion) {
      throw new AppError("Product facts changed while AI generation was running. Refresh and try again.", 409, "STALE_OPERATION");
    }
    const plan = await tx.contentPlan.create({
      data: {
        clientId: context.clientId,
        productId: product.id,
        theme: input.theme,
        objective: input.objective,
        channels: targetPlatforms,
        assetNeeds: assetIds.length ? null : "尚未关联素材",
        plannedAt: input.plannedAt,
        marketScope: client.targetMarkets.length ? client.targetMarkets.join(", ") : null,
        isGenericDraft: client.targetMarkets.length === 0,
      },
    });
    const items = [];
    for (const account of accounts) {
      const draft = generated.output.drafts.find((candidate) => candidate.platform === account.platform);
      if (!draft) throw new AppError(`平台生成结果缺失：${account.platform}`, 502, "INCOMPLETE_MODEL_OUTPUT");
      const item = await tx.contentItem.create({
        data: {
          clientId: context.clientId,
          planId: plan.id,
          accountId: account.id,
          platform: draft.platform,
          status: ContentStatus.DRAFT,
        },
      });
      const version = await tx.contentVersion.create({
        data: {
          clientId: context.clientId,
          contentItemId: item.id,
          version: 1,
          title: draft.title,
          text: draft.text,
          productDataVersion: product.dataVersion,
          promptVersionId: prompt.id,
          generator: generated.provider,
          simulated: generated.simulated,
          generationLabel: generated.simulated ? "模拟生成" : "真实模型生成",
          createdByUserId: context.userId,
          source: "AI",
          reason: "INITIAL_GENERATION",
          sourceFacts: {
            confirmedFacts,
            missingFields: draft.missingInformation,
            productId: product.id,
            productFocus: client.productFocus,
            brandGuidelines: client.brandGuidelines,
            targetMarkets: client.targetMarkets,
            pipeline: generated.pipeline,
          } as Prisma.InputJsonValue,
          assetLinks: {
            create: accessibleAssets.map((asset) => ({ clientId: context.clientId, assetId: asset.id })),
          },
        },
      });
      await tx.contentItem.update({
        where: { id: item.id },
        data: { currentVersionId: version.id },
      });
      items.push({ ...item, currentVersionId: version.id, currentVersion: version });
    }
    if (!reservation) await tx.usageLog.create({
      data: {
        clientId: context.clientId,
        capability: "multi_platform_content",
        provider: generated.provider,
        model: generated.model,
        inputUnits: generated.usage.inputUnits,
        outputUnits: generated.usage.outputUnits,
        simulated: generated.simulated,
      },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "CONTENT_PLAN_GENERATED",
        entityType: "ContentPlan",
        entityId: plan.id,
        metadata: { simulated: generated.simulated, platforms: targetPlatforms, accountIds: accounts.map((account) => account.id), pipelineStages: generated.pipeline.stages } as Prisma.InputJsonValue,
      },
    });
    return { plan, items };
  });
  return { ...result, generation: { simulated: generated.simulated, provider: generated.provider } };
}

export async function submitForReview(context: RequestContext, contentItemId: string, expectedVersionId?: string) {
  assertCanWrite(context);
  const item = await getScopedItem(context, contentItemId);
  if (expectedVersionId && item.currentVersionId !== expectedVersionId) throw new AppError("内容版本已变化，请刷新后重试。", 409, "VERSION_CONFLICT");
  const issues = await checkContent(context, contentItemId);
  const blocking = issues.filter((issue) => issue.level === "ERROR");
  if (blocking.length) {
    throw new AppError(`内容检查未通过：${blocking.map((issue) => issue.message).join("；")}`, 409, "CONTENT_CHECK_FAILED");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${item.id} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    if (liveItem.status === ContentStatus.RUNNING) throw new AppError("发布已经开始，必须等待结果或执行远端对账。", 409, "PUBLISH_IN_PROGRESS");
    if (liveItem.currentVersionId !== item.currentVersionId || (expectedVersionId && liveItem.currentVersionId !== expectedVersionId)) throw new AppError("内容已被其他操作更新，请刷新后重试。", 409, "VERSION_CONFLICT");
    await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersionId: item.currentVersionId!,
        status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "APPROVAL_REOPENED" },
    });
    const updated = await tx.contentItem.update({ where: { id: item.id }, data: { status: ContentStatus.REVIEW_PENDING, scheduledAt: null } });
    await tx.auditLog.create({
      data: { clientId: context.clientId, userId: context.userId, action: "CONTENT_SUBMITTED_FOR_REVIEW", entityType: "ContentItem", entityId: item.id },
    });
    return updated;
  });
}

export async function editContentVersion(
  context: RequestContext,
  contentItemId: string,
  input: {
    text: string;
    title?: string | null;
    assetIds?: string[];
    accountId?: string;
    expectedVersionId?: string;
    previousVersionId?: string;
    reason?: string;
    source?: "MANUAL" | "AUTOSAVE" | "RESTORE" | "AI_REWRITE" | "AI_REGENERATE";
    generator?: string;
    generationLabel?: string;
    sourceFacts?: Prisma.InputJsonValue;
  },
) {
  assertCanWrite(context);
  const item = await getScopedItem(context, contentItemId);
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  const accountId = input.accountId || item.accountId;
  const account = await db.socialAccount.findFirst({ where: { id: accountId, clientId: context.clientId } });
  if (!account) throw new AppError("目标账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
  const assetIds = input.assetIds ?? item.currentVersion.assetLinks.map((link) => link.assetId);
  const assets = await db.asset.count({ where: { id: { in: assetIds }, clientId: context.clientId } });
  if (assets !== new Set(assetIds).size) throw new AppError("素材不属于当前客户。", 403, "ASSET_SCOPE_VIOLATION");
  if (input.expectedVersionId && input.expectedVersionId !== item.currentVersion.id) {
    throw new AppError("草稿已被其他操作更新，请刷新后重试。", 409, "VERSION_CONFLICT");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${item.id} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    if (liveItem.status === ContentStatus.RUNNING) throw new AppError("发布已经开始，不能编辑；请等待结果或执行远端对账。", 409, "PUBLISH_IN_PROGRESS");
    if (liveItem.currentVersionId !== item.currentVersionId) throw new AppError("内容已被其他操作更新，请刷新后重试。", 409, "STALE_OPERATION");
    const version = await tx.contentVersion.create({
      data: {
        clientId: context.clientId,
        contentItemId: item.id,
        version: item.currentVersion!.version + 1,
        title: input.title === undefined ? item.currentVersion!.title : input.title,
        text: input.text,
        productDataVersion: item.currentVersion!.productDataVersion,
        promptVersionId: item.currentVersion!.promptVersionId,
        generator: input.generator || "operator-edit",
        simulated: item.currentVersion!.simulated,
        generationLabel: input.generationLabel || "人工编辑版本",
        sourceFacts: input.sourceFacts || item.currentVersion!.sourceFacts as Prisma.InputJsonValue,
        previousVersionId: input.previousVersionId || item.currentVersion!.id,
        createdByUserId: context.userId,
        source: input.source || "MANUAL",
        reason: input.reason || "CONTENT_EDITED",
        assetLinks: { create: assetIds.map((assetId) => ({ clientId: context.clientId, assetId })) },
      },
    });
    await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersionId: item.currentVersion!.id,
        status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "SUPERSEDED_VERSION" },
    });
    await tx.contentItem.update({
      where: { id: item.id },
      data: { currentVersionId: version.id, accountId, platform: account.platform, status: ContentStatus.DRAFT, scheduledAt: null },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "CONTENT_VERSION_CREATED",
        entityType: "ContentVersion",
        entityId: version.id,
        metadata: { previousVersionId: item.currentVersion!.id, approvalInvalidated: true },
      },
    });
    return version;
  });
}

export async function reviewContent(
  context: RequestContext,
  contentItemId: string,
  decision: ApprovalDecision,
  note?: string,
  expectedVersionId?: string,
) {
  assertCanWrite(context);
  const item = await getScopedItem(context, contentItemId);
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  if (expectedVersionId && item.currentVersion.id !== expectedVersionId) throw new AppError("审核版本已变化，请刷新后重试。", 409, "VERSION_CONFLICT");
  if (item.status !== ContentStatus.REVIEW_PENDING) {
    throw new AppError("只有待审核状态的当前版本可以批准或拒绝。", 409, "NOT_REVIEW_PENDING");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${item.id} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    if (liveItem.status === ContentStatus.RUNNING) throw new AppError("发布已经开始，不能更改审核决定；请等待结果或执行远端对账。", 409, "PUBLISH_IN_PROGRESS");
    if (liveItem.currentVersionId !== item.currentVersion!.id || (expectedVersionId && liveItem.currentVersionId !== expectedVersionId) || liveItem.accountId !== item.accountId || liveItem.status !== ContentStatus.REVIEW_PENDING) throw new AppError("审核对象已变化，请刷新后重试。", 409, "VERSION_CONFLICT");
    const approval = await tx.approval.create({
      data: {
        clientId: context.clientId,
        contentVersionId: item.currentVersion!.id,
        accountId: item.accountId,
        reviewerId: context.userId,
        decision,
        note,
      },
    });
    await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersionId: item.currentVersion!.id,
        status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: decision === ApprovalDecision.APPROVED ? "RESCHEDULE_REQUIRED" : "APPROVAL_REVOKED" },
    });
    await tx.contentItem.update({
      where: { id: item.id },
      data: { status: decision === ApprovalDecision.APPROVED ? ContentStatus.APPROVED : ContentStatus.CHANGES_REQUESTED, scheduledAt: null },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: decision === ApprovalDecision.APPROVED ? "CONTENT_APPROVED" : "CONTENT_REJECTED",
        entityType: "ContentVersion",
        entityId: item.currentVersion!.id,
        metadata: { accountId: item.accountId, note: note ?? null },
      },
    });
    return approval;
  });
}

export type SchedulePublicationInput = Date | {
  publishMode: "NOW" | "SCHEDULED";
  localDateTime?: string;
  timezone?: string;
};

const conflictItemStatuses: ContentStatus[] = [ContentStatus.SCHEDULED];
const conflictJobStatuses: PublishJobStatus[] = [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION, PublishJobStatus.RUNNING];

class PublicationGateError extends AppError {
  constructor(
    message: string,
    code: string,
    readonly contentItemId: string,
    readonly taskReason: string,
    readonly taskAction: string,
  ) {
    super(message, 409, code);
  }
}

export async function lockSchedulingClient(tx: Prisma.TransactionClient, clientId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Client" WHERE "id" = ${clientId} FOR SHARE
  `;
  if (!rows.length) throw new AppError("客户不存在或无权访问。", 404, "CLIENT_NOT_FOUND");
}

export async function lockContentItemForScheduling(tx: Prisma.TransactionClient, context: RequestContext, contentItemId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; accountId: string }>>`
    SELECT "id", "accountId" FROM "ContentItem"
    WHERE "id" = ${contentItemId} AND "clientId" = ${context.clientId}
    FOR UPDATE
  `;
  if (!rows.length) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  return rows[0];
}

export async function lockSchedulingAccount(tx: Prisma.TransactionClient, clientId: string, accountId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "SocialAccount"
    WHERE "id" = ${accountId} AND "clientId" = ${clientId}
    FOR UPDATE
  `;
  if (!rows.length) throw new AppError("账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
}

export async function findScheduleConflictsInTransaction(
  tx: Pick<Prisma.TransactionClient, "contentItem">,
  input: {
    clientId: string;
    accountId: string;
    scheduledAt: Date;
    excludeContentItemIds?: string[];
    windowMinutes?: number;
  },
) {
  const windowMinutes = input.windowMinutes ?? 5;
  const from = new Date(input.scheduledAt.getTime() - windowMinutes * 60_000);
  const to = new Date(input.scheduledAt.getTime() + windowMinutes * 60_000);
  const excludedIds = input.excludeContentItemIds || [];
  const conflicts = await tx.contentItem.findMany({
    where: {
      clientId: input.clientId,
      accountId: input.accountId,
      ...(excludedIds.length ? { id: { notIn: excludedIds } } : {}),
      OR: [
        { status: { in: conflictItemStatuses }, scheduledAt: { gte: from, lte: to } },
        { currentVersion: { publishJobs: { some: { clientId: input.clientId, status: { in: conflictJobStatuses }, nextAttemptAt: { gte: from, lte: to } } } } },
      ],
    },
    select: { id: true, status: true, scheduledAt: true, accountId: true, platform: true },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  return { conflict: conflicts.length > 0, conflicts, window: { from, to } };
}

export async function validatePublicationInTransaction(
  tx: Prisma.TransactionClient,
  context: RequestContext,
  contentItemId: string,
  scheduleInput?: SchedulePublicationInput,
) {
  const item = await getScopedItem(context, contentItemId, tx);
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  const currentVersionId = item.currentVersion.id;
  const blockingIssues = (await checkContentWithClient(context, contentItemId, tx)).filter((issue) => issue.level === "ERROR");
  if (blockingIssues.length) {
    throw new AppError(`内容检查未通过：${blockingIssues.map((issue) => issue.message).join("；")}`, 409, "CONTENT_CHECK_FAILED");
  }
  const approval = await tx.approval.findFirst({
    where: {
      clientId: context.clientId,
      contentVersionId: item.currentVersion.id,
      accountId: item.accountId,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!approval || approval.decision !== ApprovalDecision.APPROVED) {
    throw new AppError("当前平台、账号和内容版本没有有效批准。", 409, "APPROVAL_REQUIRED");
  }
  const client = await tx.client.findUniqueOrThrow({ where: { id: context.clientId } });
  assertValidTimeZone(client.timezone);
  const scheduledAt = resolveScheduledAt(scheduleInput, client.timezone);
  if (client.mode === ClientMode.DRAFT) {
    throw new PublicationGateError(
      "草稿模式只能生成和审核内容，不能发布。",
      "DRAFT_MODE_PUBLISH_BLOCKED",
      item.id,
      "草稿模式禁止对外发布",
      "切换正式模式前验证发布适配器与账号能力。",
    );
  }
  const existing = await tx.publishJob.findUnique({
    where: { clientId_contentVersionId_accountId: {
      clientId: context.clientId,
      contentVersionId: item.currentVersion.id,
      accountId: item.accountId,
    } },
  });
  const isDemo = client.mode === ClientMode.DEMO;
  const platformConnection = item.account.platformConnection;
  const registration = getPlatformRegistry().getByPlatform(item.platform);
  const liveTarget = client.mode === ClientMode.LIVE
    ? resolveLivePublishingTarget({
        platform: item.platform,
        accountType: item.account.accountType,
        isSelected: item.account.isSelected,
        publishCapability: item.account.publishCapability,
        externalAccountId: item.account.externalAccountId,
        hasEncryptedAccessToken: Boolean(
          item.account.accessTokenCiphertext &&
          item.account.accessTokenIv &&
          item.account.accessTokenAuthTag
        ),
        connection: platformConnection
          ? { provider: platformConnection.provider, status: platformConnection.status }
          : null,
        legacyFacebook: item.account.facebookConnection
          ? {
              connectionStatus: item.account.facebookConnection.connectionStatus,
              tokenStatus: item.account.facebookConnection.tokenStatus,
              pageId: item.account.facebookConnection.pageId,
            }
          : null,
      })
    : null;
  if (!registration || (!isDemo && !liveTarget)) {
    throw new PublicationGateError(
      "正式模式只允许已验证且已选择的社媒账号进入真实发布队列。",
      "LIVE_CONNECTION_REQUIRED",
      item.id,
      "社媒账号真实连接尚未验证",
      "在平台连接页完成 OAuth、账号选择和发布能力验证。",
    );
  }
  return {
    item,
    currentVersionId,
    client,
    scheduledAt,
    existing,
    provider: registration.definition.provider,
    adapterName: isDemo ? "mock-social" : liveTarget!.adapterName,
    isDemo,
  };
}

export async function schedulePublicationInTransaction(
  tx: Prisma.TransactionClient,
  context: RequestContext,
  contentItemId: string,
  scheduleInput?: SchedulePublicationInput,
) {
  const validated = await validatePublicationInTransaction(tx, context, contentItemId, scheduleInput);
  const { item, currentVersionId, scheduledAt, existing, provider, adapterName, isDemo } = validated;
  const status = PublishJobStatus.PENDING;
  if (existing) {
    if (existing.status === PublishJobStatus.CANCELLED && existing.attemptCount === 0) {
      const conflict = await findScheduleConflictsInTransaction(tx, {
        clientId: context.clientId,
        accountId: item.accountId,
        scheduledAt,
        excludeContentItemIds: [item.id],
      });
      if (conflict.conflict) throw new AppError("该账号的目标时间附近已有排期。", 409, "SCHEDULE_CONFLICT");
      const revived = await tx.publishJob.update({
        where: { id: existing.id },
        data: { status, provider, platform: item.platform, adapter: adapterName, simulated: isDemo, environment: isDemo ? "SIMULATED" : "LIVE", nextAttemptAt: scheduledAt, lastErrorCode: null, lastErrorMessage: null },
      });
      await tx.contentItem.update({
        where: { id: item.id },
        data: { scheduledAt, status: ContentStatus.SCHEDULED },
      });
      await tx.auditLog.create({
        data: { clientId: context.clientId, userId: context.userId, action: "PUBLICATION_SCHEDULED", entityType: "PublishJob", entityId: revived.id, metadata: { simulated: revived.simulated, scheduledAt: scheduledAt.toISOString(), revived: true } },
      });
      return { job: revived, scheduledAt, changed: true };
    }
    return { job: existing, scheduledAt: item.scheduledAt || existing.nextAttemptAt, changed: false };
  }
  const conflict = await findScheduleConflictsInTransaction(tx, {
    clientId: context.clientId,
    accountId: item.accountId,
    scheduledAt,
    excludeContentItemIds: [item.id],
  });
  if (conflict.conflict) throw new AppError("该账号的目标时间附近已有排期。", 409, "SCHEDULE_CONFLICT");
  const job = await tx.publishJob.create({
    data: {
      clientId: context.clientId,
      contentVersionId: currentVersionId,
      accountId: item.accountId,
      provider,
      platform: item.platform,
      idempotencyKey: sha256(`${context.clientId}:${currentVersionId}:${item.accountId}`),
      status,
      adapter: adapterName,
      simulated: isDemo,
      environment: isDemo ? "SIMULATED" : "LIVE",
      nextAttemptAt: scheduledAt,
    },
  });
  await tx.contentItem.update({
    where: { id: item.id },
    data: { scheduledAt, status: ContentStatus.SCHEDULED },
  });
  await tx.auditLog.create({
    data: { clientId: context.clientId, userId: context.userId, action: "PUBLICATION_SCHEDULED", entityType: "PublishJob", entityId: job.id, metadata: { simulated: job.simulated, scheduledAt: scheduledAt.toISOString() } },
  });
  return { job, scheduledAt, changed: true };
}

export async function persistPublicationGateTask(clientId: string, error: unknown) {
  if (!(error instanceof PublicationGateError)) return;
  await ensureManualTask(clientId, error.contentItemId, error.taskReason, error.taskAction);
}

export async function schedulePublication(context: RequestContext, contentItemId: string, scheduleInput?: SchedulePublicationInput, expectedVersionId?: string) {
  assertCanWrite(context);
  try {
    const result = await db.$transaction(async (tx) => {
      await lockSchedulingClient(tx, context.clientId);
      const lockedItem = await lockContentItemForScheduling(tx, context, contentItemId);
      if (expectedVersionId) {
        const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { currentVersionId: true } });
        if (liveItem.currentVersionId !== expectedVersionId) throw new AppError("排期版本已变化，请刷新后重试。", 409, "VERSION_CONFLICT");
      }
      await lockSchedulingAccount(tx, context.clientId, lockedItem.accountId);
      return schedulePublicationInTransaction(tx, context, contentItemId, scheduleInput);
    });
    return result.job;
  } catch (error) {
    await persistPublicationGateTask(context.clientId, error);
    throw error;
  }
}

function resolveScheduledAt(input: SchedulePublicationInput | undefined, clientTimezone: string) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new AppError("排期时间无效。", 400, "INVALID_SCHEDULE_TIME");
    if (input.getTime() <= Date.now()) throw new AppError("计划发布时间必须晚于当前时间。", 400, "SCHEDULE_TIME_IN_PAST");
    return input;
  }
  if (!input || input.publishMode === "NOW") return new Date();
  if (input.timezone && input.timezone !== clientTimezone) {
    throw new AppError("排期时区与客户配置不一致，请刷新页面。", 409, "SCHEDULE_TIMEZONE_MISMATCH");
  }
  if (!input.localDateTime) throw new AppError("请选择计划发布时间。", 400, "SCHEDULE_TIME_REQUIRED");
  const result = zonedLocalDateTimeToUtc(input.localDateTime, clientTimezone);
  if (result.getTime() <= Date.now()) throw new AppError("计划发布时间必须晚于当前时间。", 400, "SCHEDULE_TIME_IN_PAST");
  return result;
}

export async function checkContent(context: RequestContext, contentItemId: string) {
  return checkContentWithClient(context, contentItemId, db);
}

async function checkContentWithClient(
  context: RequestContext,
  contentItemId: string,
  database: Pick<Prisma.TransactionClient, "contentItem" | "platformPolicy" | "contentVersion">,
) {
  const item = await getScopedItem(context, contentItemId, database);
  if (!item.currentVersion) return [{ level: "ERROR" as const, code: "NO_VERSION", message: "内容版本缺失", evidence: item.id }];
  const issues: Array<{ level: "ERROR" | "WARNING"; code: string; message: string; evidence: string }> = [];
  const sourceFacts = item.currentVersion.sourceFacts as { missingFields?: string[] };
  if (sourceFacts.missingFields?.length) {
    issues.push({
      level: "WARNING",
      code: "MISSING_PRODUCT_FACTS",
      message: `缺失资料：${sourceFacts.missingFields.join(", ")}`,
      evidence: `contentVersion:${item.currentVersion.id}`,
    });
  }
  if (!item.currentVersion.assetLinks.length) {
    issues.push({ level: "WARNING", code: "NO_ASSET", message: "未关联图片或视频素材", evidence: item.currentVersion.id });
  }
  const product = item.plan.product;
  if (product && item.currentVersion.productDataVersion !== product.dataVersion) {
    issues.push({
      level: "ERROR",
      code: "STALE_PRODUCT_DATA",
      message: `内容使用产品资料 v${item.currentVersion.productDataVersion}，当前产品资料已是 v${product.dataVersion}`,
      evidence: `product:${product.id}`,
    });
  }
  for (const field of product?.fields || []) {
    if (field.status !== "CONFIRMED" && field.value && item.currentVersion.text.includes(field.value)) {
      issues.push({
        level: "ERROR",
        code: "UNCONFIRMED_FACT_USED",
        message: `文案使用了未确认字段 ${field.key}`,
        evidence: `productField:${field.id}`,
      });
    }
  }
  if (product) {
    for (const link of item.currentVersion.assetLinks) {
      if (!link.asset.productLinks.some((productLink) => productLink.productId === product.id)) {
        issues.push({
          level: "ERROR",
          code: "ASSET_PRODUCT_MISMATCH",
          message: "素材未关联到当前产品",
          evidence: `asset:${link.assetId}`,
        });
      }
    }
  }
  const policy = await database.platformPolicy.findUnique({
    where: { clientId_platform: { clientId: context.clientId, platform: item.platform } },
  });
  if (policy?.maxTextLength && item.currentVersion.text.length > policy.maxTextLength) {
    issues.push({
      level: "ERROR",
      code: "TEXT_TOO_LONG",
      message: `文案长度 ${item.currentVersion.text.length} 超过配置上限 ${policy.maxTextLength}`,
      evidence: `policy:${policy.id}`,
    });
  }
  const duplicate = await database.contentVersion.findFirst({
    where: {
      clientId: context.clientId,
      id: { not: item.currentVersion.id },
      text: item.currentVersion.text,
    },
  });
  if (duplicate) {
    issues.push({ level: "WARNING", code: "DUPLICATE_TEXT", message: "与已有内容完全重复", evidence: duplicate.id });
  }
  return issues;
}

async function getScopedItem(
  context: RequestContext,
  contentItemId: string,
  database: Pick<Prisma.TransactionClient, "contentItem"> = db,
) {
  const item = await database.contentItem.findFirst({
    where: { id: contentItemId, clientId: context.clientId },
    include: {
      account: { include: { facebookConnection: true, platformConnection: true } },
      plan: { include: { product: { include: { fields: true } } } },
      currentVersion: {
        include: { assetLinks: { include: { asset: { include: { productLinks: true } } } } },
      },
    },
  });
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  return item;
}

async function ensureManualTask(clientId: string, contentItemId: string | null, reason: string, action: string) {
  const existing = await db.manualTask.findFirst({
    where: { clientId, contentItemId, triggerReason: reason, status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } },
  });
  if (!existing) {
    await db.manualTask.create({
      data: {
        clientId,
        contentItemId,
        triggerReason: reason,
        priority: "HIGH",
        sourceMaterial: { contentItemId },
        requiredAction: action,
        completionCriteria: "连接验证结果和证据已记录。",
        continuationStep: "重新排期当前已批准内容。",
      },
    });
  }
}
