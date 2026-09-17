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
import { sha256 } from "../lib/security";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { releaseUsage, reserveUsage, settleUsage } from "./usage-service";

const platforms = ["facebook", "instagram", "tiktok", "linkedin"] as const;
const generateInputSchema = z.object({
  productId: z.string().min(1),
  theme: z.string().min(1),
  objective: z.string().min(1),
  platforms: z.array(z.enum(platforms)).min(1),
  assetIds: z.array(z.string()).default([]),
  plannedAt: z.coerce.date().optional(),
});

export async function generateContentPlan(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = generateInputSchema.parse(raw);
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
  const [client, accounts, prompt, textIntegration] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.socialAccount.findMany({
      where: { clientId: context.clientId, platform: { in: input.platforms } },
    }),
    db.promptVersion.findFirst({
      where: { clientId: context.clientId, capability: "multi_platform_content", active: true },
      orderBy: { createdAt: "desc" },
    }),
    db.integrationConfig.findFirst({
      where: { clientId: context.clientId, type: "TEXT_GENERATION", status: CapabilityStatus.VERIFIED },
      orderBy: { verifiedAt: "desc" },
    }),
  ]);
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
    platforms: input.platforms,
    instruction: prompt.instruction,
  };
  const reservation = configuredProvider === "openai-compatible"
    ? await reserveUsage({ clientId: context.clientId, capability: "multi_platform_content", provider: configuredProvider, units: Math.ceil(JSON.stringify(modelInput).length / 4) + Number(process.env.TEXT_MODEL_MAX_OUTPUT_UNITS || 2000) })
    : null;
  let generated;
  try {
    const adapter = getTextGenerationAdapter(configuredProvider);
    generated = await adapter.generate(modelInput);
    if (reservation) await settleUsage({ reservationId: reservation.id, clientId: context.clientId, model: generated.model, inputUnits: generated.usage.inputUnits, outputUnits: generated.usage.outputUnits });
  } catch (error) {
    if (reservation) await releaseUsage(reservation.id, context.clientId);
    throw error;
  }
  if (generated.output.drafts.length !== input.platforms.length) {
    throw new AppError("生成结果未覆盖全部平台。", 502, "INCOMPLETE_MODEL_OUTPUT");
  }

  const result = await db.$transaction(async (tx) => {
    const plan = await tx.contentPlan.create({
      data: {
        clientId: context.clientId,
        productId: product.id,
        theme: input.theme,
        objective: input.objective,
        channels: input.platforms,
        assetNeeds: assetIds.length ? null : "尚未关联素材",
        plannedAt: input.plannedAt,
        marketScope: client.targetMarkets.length ? client.targetMarkets.join(", ") : null,
        isGenericDraft: client.targetMarkets.length === 0,
      },
    });
    const items = [];
    for (const draft of generated.output.drafts) {
      const account = accounts.find((candidate) => candidate.platform === draft.platform);
      if (!account) throw new AppError(`平台账号配置缺失：${draft.platform}`, 409, "ACCOUNT_NOT_CONFIGURED");
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
          sourceFacts: {
            confirmedFacts,
            missingFields: draft.missingInformation,
            productId: product.id,
            productFocus: client.productFocus,
            brandGuidelines: client.brandGuidelines,
            targetMarkets: client.targetMarkets,
          },
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
        metadata: { simulated: generated.simulated, platforms: input.platforms },
      },
    });
    return { plan, items };
  });
  return { ...result, generation: { simulated: generated.simulated, provider: generated.provider } };
}

export async function submitForReview(context: RequestContext, contentItemId: string) {
  assertCanWrite(context);
  const item = await getScopedItem(context, contentItemId);
  const issues = await checkContent(context, contentItemId);
  const blocking = issues.filter((issue) => issue.level === "ERROR");
  if (blocking.length) {
    throw new AppError(`内容检查未通过：${blocking.map((issue) => issue.message).join("；")}`, 409, "CONTENT_CHECK_FAILED");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${item.id} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    if (liveItem.status === ContentStatus.RUNNING) throw new AppError("发布已经开始，必须等待结果或执行远端对账。", 409, "PUBLISH_IN_PROGRESS");
    if (liveItem.currentVersionId !== item.currentVersionId) throw new AppError("内容已被其他操作更新，请刷新后重试。", 409, "STALE_OPERATION");
    await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersionId: item.currentVersionId!,
        status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "APPROVAL_REOPENED" },
    });
    const updated = await tx.contentItem.update({ where: { id: item.id }, data: { status: ContentStatus.REVIEW_PENDING } });
    await tx.auditLog.create({
      data: { clientId: context.clientId, userId: context.userId, action: "CONTENT_SUBMITTED_FOR_REVIEW", entityType: "ContentItem", entityId: item.id },
    });
    return updated;
  });
}

export async function editContentVersion(
  context: RequestContext,
  contentItemId: string,
  input: { text: string; title?: string | null; assetIds?: string[]; accountId?: string },
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
        generator: "operator-edit",
        simulated: item.currentVersion!.simulated,
        generationLabel: "人工编辑版本",
        sourceFacts: item.currentVersion!.sourceFacts as Prisma.InputJsonValue,
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
      data: { currentVersionId: version.id, accountId, platform: account.platform, status: ContentStatus.DRAFT },
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
) {
  assertCanWrite(context);
  const item = await getScopedItem(context, contentItemId);
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  if (item.status !== ContentStatus.REVIEW_PENDING) {
    throw new AppError("只有待审核状态的当前版本可以批准或拒绝。", 409, "NOT_REVIEW_PENDING");
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${item.id} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    if (liveItem.status === ContentStatus.RUNNING) throw new AppError("发布已经开始，不能更改审核决定；请等待结果或执行远端对账。", 409, "PUBLISH_IN_PROGRESS");
    if (liveItem.currentVersionId !== item.currentVersion!.id || liveItem.accountId !== item.accountId || liveItem.status !== ContentStatus.REVIEW_PENDING) throw new AppError("审核对象已变化，请刷新后重试。", 409, "STALE_OPERATION");
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
      data: { status: decision === ApprovalDecision.APPROVED ? ContentStatus.APPROVED : ContentStatus.CHANGES_REQUESTED },
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

export async function schedulePublication(context: RequestContext, contentItemId: string, scheduledAt?: Date) {
  assertCanWrite(context);
  const item = await getScopedItem(context, contentItemId);
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  const blockingIssues = (await checkContent(context, contentItemId)).filter((issue) => issue.level === "ERROR");
  if (blockingIssues.length) {
    throw new AppError(`内容检查未通过：${blockingIssues.map((issue) => issue.message).join("；")}`, 409, "CONTENT_CHECK_FAILED");
  }
  const approval = await db.approval.findFirst({
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
  const client = await db.client.findUniqueOrThrow({ where: { id: context.clientId } });
  if (client.mode === ClientMode.DRAFT) {
    await ensureManualTask(context.clientId, item.id, "草稿模式禁止对外发布", "切换正式模式前验证发布适配器与账号能力。" );
    throw new AppError("草稿模式只能生成和审核内容，不能发布。", 409, "DRAFT_MODE_PUBLISH_BLOCKED");
  }
  const idempotencyKey = sha256(`${context.clientId}:${item.currentVersion.id}:${item.accountId}`);
  const existing = await db.publishJob.findUnique({
    where: { clientId_contentVersionId_accountId: {
      clientId: context.clientId,
      contentVersionId: item.currentVersion.id,
      accountId: item.accountId,
    } },
  });
  const isDemo = client.mode === ClientMode.DEMO;
  const facebookConnection = item.account.facebookConnection;
  const readyForLive = client.mode === ClientMode.LIVE
    && item.platform === "facebook"
    && item.account.publishCapability === CapabilityStatus.VERIFIED
    && facebookConnection?.connectionStatus === CapabilityStatus.VERIFIED
    && facebookConnection.tokenStatus === "VALID"
    && item.account.externalAccountId === facebookConnection.pageId;
  if (!isDemo && !readyForLive) {
    await ensureManualTask(context.clientId, item.id, "Facebook Page 真实连接尚未验证", "在设置页配置服务器密钥引用，并完成 Page、权限和令牌验证。" );
    throw new AppError("正式模式只允许已验证的 Facebook Page 进入真实发布队列。", 409, "LIVE_CONNECTION_REQUIRED");
  }
  const status = PublishJobStatus.PENDING;
  if (existing) {
    if (existing.status === PublishJobStatus.CANCELLED && existing.attemptCount === 0) {
      const revived = await db.publishJob.update({
        where: { id: existing.id },
        data: { status, adapter: isDemo ? "mock-social" : "facebook-graph", simulated: isDemo, environment: isDemo ? "SIMULATED" : "LIVE", nextAttemptAt: scheduledAt || new Date(), lastErrorCode: null, lastErrorMessage: null },
      });
      await db.contentItem.update({
        where: { id: item.id },
        data: { scheduledAt: scheduledAt || new Date(), status: ContentStatus.SCHEDULED },
      });
      return revived;
    }
    return existing;
  }
  let job;
  try {
    job = await db.publishJob.create({
      data: {
        clientId: context.clientId,
        contentVersionId: item.currentVersion.id,
        accountId: item.accountId,
        idempotencyKey,
        status,
        adapter: isDemo ? "mock-social" : "facebook-graph",
        simulated: isDemo,
        environment: isDemo ? "SIMULATED" : "LIVE",
        nextAttemptAt: scheduledAt || new Date(),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return db.publishJob.findUniqueOrThrow({
        where: { clientId_contentVersionId_accountId: { clientId: context.clientId, contentVersionId: item.currentVersion.id, accountId: item.accountId } },
      });
    }
    throw error;
  }
  await db.contentItem.update({
    where: { id: item.id },
    data: {
      scheduledAt: scheduledAt || new Date(),
      status: ContentStatus.SCHEDULED,
    },
  });
  await db.auditLog.create({
    data: { clientId: context.clientId, userId: context.userId, action: "PUBLICATION_SCHEDULED", entityType: "PublishJob", entityId: job.id, metadata: { simulated: job.simulated } },
  });
  return job;
}

export async function checkContent(context: RequestContext, contentItemId: string) {
  const item = await getScopedItem(context, contentItemId);
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
  const policy = await db.platformPolicy.findUnique({
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
  const duplicate = await db.contentVersion.findFirst({
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

async function getScopedItem(context: RequestContext, contentItemId: string) {
  const item = await db.contentItem.findFirst({
    where: { id: contentItemId, clientId: context.clientId },
    include: {
      account: { include: { facebookConnection: true } },
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
