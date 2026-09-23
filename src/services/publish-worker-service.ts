import { randomUUID } from "node:crypto";
import { ApprovalDecision, AttemptStatus, ClientMode, ContentStatus, Prisma, PublishJobStatus, type PublishJob } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { MockSocialPublishAdapter } from "../lib/adapters/publishing";
import type { SocialPublishAdapter } from "../lib/adapters/types";
import { sha256 } from "../lib/security";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { FACEBOOK_ERROR_ADVICE, type FacebookErrorCategory } from "../lib/adapters/facebook-graph";
import { classifyPublishFailure, decidePublishRetry } from "../lib/publish-safety";
import { safeErrorMessage } from "../lib/token-vault";
import { resolvePublishAdapter } from "./publish-adapter-service";
import { recordDomainEvent } from "../lib/domain-events";
import {
  dispatchPreparedNotification,
  prepareNotificationEvent,
  type NotificationEvent,
  type NotificationTransport,
  type PreparedNotificationEvent,
} from "./notification-service";

export async function recoverStaleJobs(lockTimeoutSeconds: number, notificationTransport?: NotificationTransport) {
  const cutoff = new Date(Date.now() - lockTimeoutSeconds * 1000);
  const stale = await db.publishJob.findMany({
    where: { status: PublishJobStatus.RUNNING, lockedAt: { lt: cutoff } },
    include: { contentVersion: { select: { contentItemId: true } }, attempts: { where: { status: AttemptStatus.DISPATCHING }, orderBy: { number: "desc" }, take: 1 } },
  });
  let recovered = 0;
  for (const job of stale) {
    const dispatchStarted = job.attempts.length > 0;
    const won = await db.$transaction(async (tx) => {
      const claimed = await tx.publishJob.updateMany({
        where: { id: job.id, status: PublishJobStatus.RUNNING, lockedAt: { lt: cutoff }, lockedBy: job.lockedBy },
        data: dispatchStarted
          ? { status: PublishJobStatus.UNKNOWN, lockedAt: null, lockedBy: null, lastErrorCode: "WORKER_LOST_AFTER_DISPATCH", lastErrorMessage: "worker 在发送开始后失联，远端结果未知，禁止自动重试。" }
          : { status: PublishJobStatus.RETRY, lockedAt: null, lockedBy: null, nextAttemptAt: new Date(), lastErrorCode: "STALE_LOCK_RECOVERED" },
      });
      if (claimed.count !== 1) return { won: false, preparedNotification: null };
      if (dispatchStarted) {
        await tx.contentItem.update({ where: { id: job.contentVersion.contentItemId }, data: { status: ContentStatus.UNKNOWN } });
        await tx.publishAttempt.update({ where: { id: job.attempts[0].id }, data: { status: AttemptStatus.UNKNOWN, finishedAt: new Date(), errorCode: "WORKER_LOST" } });
        const reason = "发布结果未知，需要远端查询对账，禁止盲目重发";
        await ensureFailureTask(tx, job.clientId, job.contentVersion.contentItemId, job.id, reason, "WORKER_LOST_AFTER_DISPATCH");
        await recordDomainEvent({ clientId: job.clientId }, {
          type: "PUBLISH_UNKNOWN",
          entityType: "PublishJob",
          entityId: job.id,
          metadata: { contentItemId: job.contentVersion.contentItemId, errorCode: "WORKER_LOST_AFTER_DISPATCH" },
        }, tx);
        const preparedNotification = await prepareNotificationEvent(tx, { clientId: job.clientId }, publishNotificationEvent(
          "PUBLISH_UNKNOWN",
          job.id,
          reason,
          "WORKER_LOST_AFTER_DISPATCH",
        ));
        return { won: true, preparedNotification };
      }
      return { won: true, preparedNotification: null };
    });
    if (won.won) {
      recovered += 1;
      if (won.preparedNotification) await dispatchNotificationWithoutAffectingBusiness(won.preparedNotification, notificationTransport);
    }
  }
  return recovered;
}

export async function claimNextJob(workerId: string): Promise<PublishJob | null> {
  const leaseToken = `${workerId}:${randomUUID()}`;
  const rows = await db.$queryRaw<PublishJob[]>`
    WITH candidate AS (
      SELECT "id" FROM "PublishJob"
      WHERE "status" IN ('PENDING'::"PublishJobStatus", 'RETRY'::"PublishJobStatus") AND "nextAttemptAt" <= NOW()
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "PublishJob" AS job SET "status" = 'RUNNING'::"PublishJobStatus", "lockedAt" = NOW(), "lockedBy" = ${leaseToken}, "updatedAt" = NOW()
    FROM candidate WHERE job."id" = candidate."id" RETURNING job.*
  `;
  return rows[0] ?? null;
}

export async function claimPublishJob(jobId: string, workerId: string): Promise<PublishJob | null> {
  const leaseToken = `${workerId}:${randomUUID()}`;
  const rows = await db.$queryRaw<PublishJob[]>`
    UPDATE "PublishJob" SET "status" = 'RUNNING'::"PublishJobStatus", "lockedAt" = NOW(), "lockedBy" = ${leaseToken}, "updatedAt" = NOW()
    WHERE "id" = ${jobId} AND "status" IN ('PENDING'::"PublishJobStatus", 'RETRY'::"PublishJobStatus") AND "nextAttemptAt" <= NOW()
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function renewPublishJobLease(jobId: string, leaseToken: string) {
  const renewed = await db.publishJob.updateMany({
    where: { id: jobId, status: PublishJobStatus.RUNNING, lockedBy: leaseToken },
    data: { lockedAt: new Date() },
  });
  return renewed.count === 1;
}

export async function processPublishJob(jobId: string, injectedAdapter?: SocialPublishAdapter, notificationTransport?: NotificationTransport) {
  const job = await db.publishJob.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      client: true,
      account: true,
      contentVersion: { include: { item: { include: { plan: { include: { product: true } } } }, assetLinks: { include: { asset: true } } } },
    },
  });
  if (job.status !== PublishJobStatus.RUNNING || !job.lockedBy) return job;
  const leaseToken = job.lockedBy;
  if (job.account.clientId !== job.clientId || job.contentVersion.clientId !== job.clientId || job.contentVersion.item.clientId !== job.clientId) {
    await cancelClaim(job.id, leaseToken, "TENANT_SCOPE_MISMATCH", "任务关联实体的客户范围不一致，已阻止执行。");
    return db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  const currentVersionValid = job.contentVersion.item.currentVersionId === job.contentVersionId;
  const productVersionValid = !job.contentVersion.item.plan.product || job.contentVersion.productDataVersion === job.contentVersion.item.plan.product.dataVersion;
  const latestApproval = await db.approval.findFirst({
    where: { clientId: job.clientId, contentVersionId: job.contentVersionId, accountId: job.accountId },
    orderBy: { createdAt: "desc" },
  });
  if (!currentVersionValid || !productVersionValid || latestApproval?.decision !== ApprovalDecision.APPROVED) {
    const code = !currentVersionValid ? "SUPERSEDED_VERSION" : !productVersionValid ? "PRODUCT_FACTS_CHANGED" : "APPROVAL_MISSING";
    await cancelClaim(job.id, leaseToken, code);
    return db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  let adapter: SocialPublishAdapter;
  if (job.client.mode === ClientMode.DEMO && injectedAdapter && !injectedAdapter.simulated) {
    throw new Error("DEMO_MODE_REAL_ADAPTER_BLOCKED");
  }
  if (job.client.mode === ClientMode.LIVE && injectedAdapter?.simulated) {
    throw new Error("LIVE_MODE_SIMULATED_ADAPTER_BLOCKED");
  }
  const persistedBoundaryValid = job.client.mode === ClientMode.DEMO
    ? job.simulated && job.environment === "SIMULATED" && job.adapter === "mock-social"
    : job.client.mode === ClientMode.LIVE
      ? !job.simulated
        && job.environment === "LIVE"
        && Boolean(job.provider && job.platform)
        && job.platform === job.account.platform
        && job.adapter !== "mock-social"
      : false;
  if (!persistedBoundaryValid) {
    await cancelClaim(job.id, leaseToken, "MODE_ADAPTER_BOUNDARY_CLOSED", "客户运行模式或任务适配器环境已变化，执行已取消。 ");
    return db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  try {
    if (job.client.mode === ClientMode.DEMO) {
      adapter = injectedAdapter ?? new MockSocialPublishAdapter();
    } else {
      adapter = injectedAdapter ?? await resolvePublishAdapter(job);
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : error instanceof Error ? error.message : "LIVE_ADAPTER_UNAVAILABLE";
    const preparedNotification = await db.$transaction(async (tx) => {
      const updated = await tx.publishJob.updateMany({ where: { id: job.id, status: PublishJobStatus.RUNNING, lockedBy: leaseToken }, data: { status: PublishJobStatus.WAITING_CONFIGURATION, lockedAt: null, lockedBy: null, lastErrorCode: code, lastErrorMessage: "发布适配器或账号连接在执行前不可用。" } });
      if (updated.count !== 1) return null;
      const reason = "发布连接在执行前不可用";
      await ensureFailureTask(tx, job.clientId, job.contentVersion.item.id, job.id, reason, code);
      await recordDomainEvent({ clientId: job.clientId }, { type: "CONNECTION_ERROR", entityType: "PublishJob", entityId: job.id, metadata: { contentItemId: job.contentVersion.item.id, errorCode: code } }, tx);
      return prepareNotificationEvent(tx, { clientId: job.clientId }, publishNotificationEvent("CONNECTION_ERROR", job.id, reason, code));
    });
    if (preparedNotification) await dispatchNotificationWithoutAffectingBusiness(preparedNotification, notificationTransport);
    return db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  const attemptNumber = job.attemptCount + 1;
  const requestFingerprint = sha256(JSON.stringify({ versionId: job.contentVersionId, accountId: job.accountId, text: job.contentVersion.text, assets: job.contentVersion.assetLinks.map((link) => link.asset.storageKey).sort() }));
  const attempt = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${job.contentVersion.item.id} FOR UPDATE`;
    const [heldJob, liveItem, liveApproval] = await Promise.all([
      tx.publishJob.findFirst({ where: { id: job.id, status: PublishJobStatus.RUNNING, lockedBy: leaseToken } }),
      tx.contentItem.findUnique({ where: { id: job.contentVersion.item.id }, include: { plan: { include: { product: true } } } }),
      tx.approval.findFirst({ where: { clientId: job.clientId, contentVersionId: job.contentVersionId, accountId: job.accountId }, orderBy: { createdAt: "desc" } }),
    ]);
    const gateOpen = heldJob && liveItem && liveItem.currentVersionId === job.contentVersionId && liveApproval?.decision === ApprovalDecision.APPROVED && (!liveItem.plan.product || liveItem.plan.product.dataVersion === job.contentVersion.productDataVersion);
    if (!gateOpen) {
      if (heldJob) await tx.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.CANCELLED, lockedAt: null, lockedBy: null, lastErrorCode: "PRE_DISPATCH_GATE_CLOSED" } });
      return null;
    }
    const leaseRenewed = await tx.publishJob.updateMany({
      where: { id: job.id, status: PublishJobStatus.RUNNING, lockedBy: leaseToken },
      data: { attemptCount: attemptNumber, lockedAt: new Date() },
    });
    if (leaseRenewed.count !== 1) return null;
    await tx.contentItem.update({ where: { id: liveItem.id }, data: { status: ContentStatus.RUNNING } });
    return tx.publishAttempt.create({ data: { clientId: job.clientId, publishJobId: job.id, number: attemptNumber, status: AttemptStatus.DISPATCHING, requestFingerprint } });
  });
  if (!attempt) return db.publishJob.findUniqueOrThrow({ where: { id: job.id } });

  let result;
  const heartbeat = startLeaseHeartbeat(job.id, leaseToken);
  try {
    result = await adapter.publish({ clientId: job.clientId, platform: job.account.platform, accountExternalId: job.account.externalAccountId, text: job.contentVersion.text, assets: job.contentVersion.assetLinks.map((link) => ({ storageProvider: link.asset.storageProvider, storageKey: link.asset.storageKey, mimeType: link.asset.mimeType, originalName: link.asset.originalName })), idempotencyKey: job.idempotencyKey });
  } catch (error) {
    result = { status: "unknown" as const, code: "ADAPTER_THROW_AFTER_DISPATCH", message: safeErrorMessage(error) };
  } finally {
    heartbeat.stop();
  }
  if (heartbeat.leaseLost()) return db.publishJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  const uncertainRemotePostId = "remotePostId" in result ? result.remotePostId : undefined;
  const uncertainRemotePostUrl = "remotePostUrl" in result ? result.remotePostUrl : undefined;

  const preparedNotification = await db.$transaction(async (tx) => {
    const retryDecision = result.status === "failed"
      ? decidePublishRetry({
          phase: result.failurePhase ?? "POST_DISPATCH",
          category: classifyPublishFailure(result.code, result.failurePhase ?? "POST_DISPATCH"),
          attempt: attemptNumber,
          maxAttempts: job.maxAttempts,
          adapterRetryable: result.retryable,
        })
      : null;
    const finalStatus = result.status === "published"
      ? PublishJobStatus.PUBLISHED
      : result.status === "unknown" || retryDecision === "UNKNOWN"
        ? PublishJobStatus.UNKNOWN
        : retryDecision === "RETRY"
          ? PublishJobStatus.RETRY
          : PublishJobStatus.FAILED;
    const data = result.status === "published"
      ? { status: finalStatus, remotePostId: result.remotePostId, remotePostUrl: result.remotePostUrl, publishedAt: result.publishedAt, lockedAt: null, lockedBy: null }
      : finalStatus === PublishJobStatus.UNKNOWN
        ? { status: finalStatus, remotePostId: uncertainRemotePostId, remotePostUrl: uncertainRemotePostUrl, lockedAt: null, lockedBy: null, lastErrorCode: result.code, lastErrorMessage: result.message }
        : { status: finalStatus, nextAttemptAt: finalStatus === PublishJobStatus.RETRY ? new Date(Date.now() + 5_000 * attemptNumber) : job.nextAttemptAt, lockedAt: null, lockedBy: null, lastErrorCode: result.code, lastErrorMessage: result.message };
    const held = await tx.publishJob.updateMany({ where: { id: job.id, status: PublishJobStatus.RUNNING, lockedBy: leaseToken }, data });
    if (held.count !== 1) return null;
    await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: result.status === "published"
        ? { status: AttemptStatus.SUCCEEDED, finishedAt: new Date(), remotePostId: result.remotePostId, remotePostUrl: result.remotePostUrl }
        : finalStatus === PublishJobStatus.UNKNOWN
          ? { status: AttemptStatus.UNKNOWN, finishedAt: new Date(), errorCode: result.code, errorMessage: result.message, remotePostId: uncertainRemotePostId, remotePostUrl: uncertainRemotePostUrl }
          : { status: AttemptStatus.FAILED, finishedAt: new Date(), errorCode: result.code, errorMessage: result.message },
    });
    await tx.contentItem.update({ where: { id: job.contentVersion.item.id }, data: { status: finalStatus === PublishJobStatus.PUBLISHED ? ContentStatus.PUBLISHED : finalStatus === PublishJobStatus.UNKNOWN ? ContentStatus.UNKNOWN : finalStatus === PublishJobStatus.FAILED ? ContentStatus.FAILED : ContentStatus.SCHEDULED } });
    if (job.environment === "LIVE" && result.status !== "published" && (result.code === "TOKEN_INVALID" || result.code === "PERMISSION_DENIED")) {
      await tx.facebookPageConnection.updateMany({
        where: { clientId: job.clientId, accountId: job.accountId },
        data: {
          connectionStatus: "UNVERIFIED",
          tokenStatus: result.code === "TOKEN_INVALID" ? "EXPIRED" : "VALID",
          lastCheckedAt: new Date(),
          lastErrorCategory: result.code,
          lastErrorMessage: result.message,
        },
      });
      if (job.account.platformConnectionId) {
        await tx.platformConnection.updateMany({
          where: { id: job.account.platformConnectionId, clientId: job.clientId },
          data: {
            status: result.code === "TOKEN_INVALID" ? "TOKEN_EXPIRED" : result.code === "PERMISSION_DENIED" ? "PERMISSION_MISSING" : "ERROR",
            lastErrorCode: result.code,
            lastErrorMessage: result.message,
          },
        });
      }
      await tx.socialAccount.update({ where: { id: job.accountId }, data: { publishCapability: "UNVERIFIED", metricsCapability: "UNVERIFIED", commentsCapability: "UNVERIFIED", verifiedAt: null } });
    }
    const createTaskReason = finalStatus === PublishJobStatus.UNKNOWN
      ? "发布结果未知，需要远端查询对账，禁止盲目重发"
      : finalStatus === PublishJobStatus.FAILED
        ? result.status === "failed" ? `发布失败：${result.code}` : "发布重试次数已用尽"
        : null;
    if (!createTaskReason) return null;
    const errorCode = result.status === "published" ? undefined : result.code;
    const eventType = finalStatus === PublishJobStatus.UNKNOWN ? "PUBLISH_UNKNOWN" : "PUBLISH_FAILED";
    await ensureFailureTask(tx, job.clientId, job.contentVersion.item.id, job.id, createTaskReason, errorCode);
    await recordDomainEvent({ clientId: job.clientId }, {
      type: eventType,
      entityType: "PublishJob",
      entityId: job.id,
      metadata: { contentItemId: job.contentVersion.item.id, errorCode: errorCode ?? null },
    }, tx);
    return prepareNotificationEvent(tx, { clientId: job.clientId }, publishNotificationEvent(eventType, job.id, createTaskReason, errorCode));
  });
  if (preparedNotification) await dispatchNotificationWithoutAffectingBusiness(preparedNotification, notificationTransport);
  return db.publishJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
}

function startLeaseHeartbeat(jobId: string, leaseToken: string) {
  const intervalMs = Math.max(1_000, Number(process.env.WORKER_HEARTBEAT_MS || process.env.WORKER_HEARTBEAT_INTERVAL_MS || 10_000));
  let stopped = false;
  let lost = false;
  let renewing = false;
  const timer = setInterval(async () => {
    if (stopped || renewing) return;
    renewing = true;
    try {
      if (!(await renewPublishJobLease(jobId, leaseToken))) lost = true;
    } catch {
      lost = true;
    } finally {
      renewing = false;
    }
  }, intervalMs);
  timer.unref();
  return {
    stop() { stopped = true; clearInterval(timer); },
    leaseLost() { return lost; },
  };
}

const reconciliationSchema = z.object({
  outcome: z.enum(["PUBLISHED", "FAILED", "KEEP_UNKNOWN"]),
  remotePostId: z.string().min(1).optional(),
  remotePostUrl: z.string().url().optional().or(z.literal("")),
  note: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.outcome === "PUBLISHED" && !value.remotePostId) ctx.addIssue({ code: "custom", message: "确认发布成功时必须填写远端帖子 ID。" });
});

export async function reconcileUnknownPublish(context: RequestContext, jobId: string, raw: unknown) {
  assertCanWrite(context);
  const input = reconciliationSchema.parse(raw);
  const job = await db.publishJob.findFirst({ where: { id: jobId, clientId: context.clientId }, include: { contentVersion: { select: { contentItemId: true, clientId: true, item: { select: { clientId: true, currentVersionId: true } } } }, account: { select: { clientId: true } } } });
  if (!job) throw new AppError("发布任务不存在或无权访问。", 404, "PUBLISH_JOB_NOT_FOUND");
  if (job.contentVersion.clientId !== context.clientId || job.contentVersion.item.clientId !== context.clientId || job.account.clientId !== context.clientId) throw new AppError("发布任务关联实体的客户范围不一致。", 409, "TENANT_SCOPE_MISMATCH");
  if (job.status !== PublishJobStatus.UNKNOWN) throw new AppError("只有结果未知的任务可以人工对账。", 409, "JOB_NOT_UNKNOWN");
  if (input.outcome === "KEEP_UNKNOWN") return job;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${job.contentVersion.contentItemId} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: job.contentVersion.contentItemId }, select: { currentVersionId: true } });
    const liveJob = await tx.publishJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    if (liveJob.status !== PublishJobStatus.UNKNOWN) throw new AppError("发布任务已被其他对账操作更新。", 409, "STALE_OPERATION");
    const published = input.outcome === "PUBLISHED";
    const updated = await tx.publishJob.update({
      where: { id: job.id },
      data: published ? { status: PublishJobStatus.PUBLISHED, remotePostId: input.remotePostId, remotePostUrl: input.remotePostUrl || null, publishedAt: new Date(), lastErrorCode: null, lastErrorMessage: null } : { status: PublishJobStatus.FAILED, lastErrorCode: "MANUAL_RECONCILIATION_FAILED", lastErrorMessage: input.note },
    });
    const latestAttempt = await tx.publishAttempt.findFirst({ where: { publishJobId: job.id, status: AttemptStatus.UNKNOWN }, orderBy: { number: "desc" } });
    if (latestAttempt) await tx.publishAttempt.update({ where: { id: latestAttempt.id }, data: published ? { status: AttemptStatus.SUCCEEDED, remotePostId: input.remotePostId, remotePostUrl: input.remotePostUrl || null, finishedAt: new Date() } : { status: AttemptStatus.FAILED, errorCode: "MANUAL_RECONCILIATION_FAILED", errorMessage: input.note, finishedAt: new Date() } });
    if (liveItem.currentVersionId === job.contentVersionId) await tx.contentItem.update({ where: { id: job.contentVersion.contentItemId }, data: { status: published ? ContentStatus.PUBLISHED : ContentStatus.FAILED } });
    await tx.manualTask.updateMany({ where: { clientId: context.clientId, publishJobId: job.id, status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } }, data: { status: "COMPLETED", completedAt: new Date() } });
    await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "PUBLISH_RESULT_RECONCILED", entityType: "PublishJob", entityId: job.id, metadata: { outcome: input.outcome, note: input.note, remotePostId: input.remotePostId ?? null } } });
    return updated;
  });
}

async function cancelClaim(jobId: string, leaseToken: string, code: string, message?: string) {
  return db.publishJob.updateMany({ where: { id: jobId, status: PublishJobStatus.RUNNING, lockedBy: leaseToken }, data: { status: PublishJobStatus.CANCELLED, lockedAt: null, lockedBy: null, lastErrorCode: code, lastErrorMessage: message } });
}

async function ensureFailureTask(tx: Prisma.TransactionClient, clientId: string, contentItemId: string, publishJobId: string, reason: string, errorCode?: string) {
  const existing = await tx.manualTask.findFirst({ where: { clientId, publishJobId, triggerReason: reason, status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } } });
  if (!existing) {
    await tx.manualTask.create({ data: { clientId, contentItemId, publishJobId, triggerReason: reason, priority: "URGENT", sourceMaterial: { contentItemId, publishJobId, errorCode: errorCode || null }, requiredAction: errorCode && errorCode in FACEBOOK_ERROR_ADVICE ? FACEBOOK_ERROR_ADVICE[errorCode as FacebookErrorCategory] : "检查远端平台、账号连接和执行记录；确认结果后人工对账。", completionCriteria: "远端帖子状态已确认，并在系统记录远端 ID 或失败原因。", continuationStep: "确认成功则标记发布；确认失败后由运营者决定是否创建新任务。" } });
  }
  return existing;
}

function publishNotificationEvent(
  eventType: "PUBLISH_FAILED" | "PUBLISH_UNKNOWN" | "CONNECTION_ERROR",
  publishJobId: string,
  reason: string,
  errorCode?: string,
): NotificationEvent {
  return {
    eventType,
    title: eventType === "PUBLISH_UNKNOWN" ? "发布结果未知，需要人工对账" : eventType === "PUBLISH_FAILED" ? "发布任务失败" : "发布连接不可用",
    body: errorCode ? `${reason}（${errorCode}）` : reason,
    relatedType: "PublishJob",
    relatedId: publishJobId,
    urgent: true,
    dedupeKey: `${eventType}:PublishJob:${publishJobId}`,
  };
}

async function dispatchNotificationWithoutAffectingBusiness(prepared: PreparedNotificationEvent, transport?: NotificationTransport) {
  try {
    await dispatchPreparedNotification(prepared, transport);
  } catch (error) {
    try {
      await db.auditLog.create({
        data: {
          clientId: prepared.notification.clientId,
          action: "NOTIFICATION_DISPATCH_FAILED",
          entityType: "InAppNotification",
          entityId: prepared.notification.id,
          metadata: { error: safeErrorMessage(error) },
        },
      });
    } catch {
      // The business state and manual task are already committed; notification infrastructure must not roll them back.
    }
  }
}
