import { randomUUID } from "node:crypto";
import { ApprovalDecision, AttemptStatus, ClientMode, ContentStatus, PublishJobStatus, type PublishJob } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { MockSocialPublishAdapter } from "../lib/adapters/publishing";
import type { SocialPublishAdapter } from "../lib/adapters/types";
import { sha256 } from "../lib/security";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";

export async function recoverStaleJobs(lockTimeoutSeconds: number) {
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
      if (claimed.count !== 1) return false;
      if (dispatchStarted) {
        await tx.contentItem.update({ where: { id: job.contentVersion.contentItemId }, data: { status: ContentStatus.UNKNOWN } });
        await tx.publishAttempt.update({ where: { id: job.attempts[0].id }, data: { status: AttemptStatus.UNKNOWN, finishedAt: new Date(), errorCode: "WORKER_LOST" } });
      }
      return true;
    });
    if (won) {
      recovered += 1;
      if (dispatchStarted) await createFailureTask(job.clientId, job.contentVersion.contentItemId, job.id, "发布结果未知，需要远端查询对账，禁止盲目重发");
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

export async function processPublishJob(jobId: string, injectedAdapter?: SocialPublishAdapter) {
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
  if (job.client.mode !== ClientMode.DEMO || !job.simulated || job.adapter !== "mock-social") {
    await createFailureTask(job.clientId, job.contentVersion.item.id, job.id, "真实发布适配器未实现或未验证");
    await db.publishJob.updateMany({ where: { id: job.id, status: PublishJobStatus.RUNNING, lockedBy: leaseToken }, data: { status: PublishJobStatus.WAITING_CONFIGURATION, lockedAt: null, lockedBy: null, lastErrorCode: "LIVE_ADAPTER_UNAVAILABLE" } });
    return db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  const adapter = injectedAdapter ?? new MockSocialPublishAdapter();
  if (!adapter.simulated) throw new Error("DEMO_MODE_REAL_ADAPTER_BLOCKED");
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
  try {
    result = await adapter.publish({ clientId: job.clientId, platform: job.account.platform, accountExternalId: job.account.externalAccountId, text: job.contentVersion.text, assetKeys: job.contentVersion.assetLinks.map((link) => link.asset.storageKey), idempotencyKey: job.idempotencyKey });
  } catch (error) {
    result = { status: "unknown" as const, code: "ADAPTER_THROW_AFTER_DISPATCH", message: error instanceof Error ? error.message : "适配器调用异常" };
  }

  let createTaskReason: string | null = null;
  await db.$transaction(async (tx) => {
    const finalStatus = result.status === "published" ? PublishJobStatus.PUBLISHED : result.status === "unknown" ? PublishJobStatus.UNKNOWN : attemptNumber >= job.maxAttempts || !result.retryable ? PublishJobStatus.FAILED : PublishJobStatus.RETRY;
    const data = result.status === "published"
      ? { status: finalStatus, remotePostId: result.remotePostId, remotePostUrl: result.remotePostUrl, publishedAt: result.publishedAt, lockedAt: null, lockedBy: null }
      : result.status === "unknown"
        ? { status: finalStatus, lockedAt: null, lockedBy: null, lastErrorCode: result.code, lastErrorMessage: result.message }
        : { status: finalStatus, nextAttemptAt: finalStatus === PublishJobStatus.RETRY ? new Date(Date.now() + 5_000 * attemptNumber) : job.nextAttemptAt, lockedAt: null, lockedBy: null, lastErrorCode: result.code, lastErrorMessage: result.message };
    const held = await tx.publishJob.updateMany({ where: { id: job.id, status: PublishJobStatus.RUNNING, lockedBy: leaseToken }, data });
    if (held.count !== 1) return;
    await tx.publishAttempt.update({
      where: { id: attempt.id },
      data: result.status === "published"
        ? { status: AttemptStatus.SUCCEEDED, finishedAt: new Date(), remotePostId: result.remotePostId, remotePostUrl: result.remotePostUrl }
        : result.status === "unknown"
          ? { status: AttemptStatus.UNKNOWN, finishedAt: new Date(), errorCode: result.code, errorMessage: result.message }
          : { status: AttemptStatus.FAILED, finishedAt: new Date(), errorCode: result.code, errorMessage: result.message },
    });
    await tx.contentItem.update({ where: { id: job.contentVersion.item.id }, data: { status: finalStatus === PublishJobStatus.PUBLISHED ? ContentStatus.PUBLISHED : finalStatus === PublishJobStatus.UNKNOWN ? ContentStatus.UNKNOWN : finalStatus === PublishJobStatus.FAILED ? ContentStatus.FAILED : ContentStatus.SCHEDULED } });
    if (finalStatus === PublishJobStatus.UNKNOWN) createTaskReason = "发布结果未知，需要远端查询对账，禁止盲目重发";
    if (finalStatus === PublishJobStatus.FAILED) createTaskReason = "发布重试次数已用尽";
  });
  if (createTaskReason) await createFailureTask(job.clientId, job.contentVersion.item.id, job.id, createTaskReason);
  return db.publishJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
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

async function createFailureTask(clientId: string, contentItemId: string, publishJobId: string, reason: string) {
  const existing = await db.manualTask.findFirst({ where: { clientId, publishJobId, triggerReason: reason, status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } } });
  if (!existing) {
    await db.$transaction([
      db.manualTask.create({ data: { clientId, contentItemId, publishJobId, triggerReason: reason, priority: "URGENT", sourceMaterial: { contentItemId, publishJobId }, requiredAction: "检查远端平台、账号连接和执行记录；确认结果后人工对账。", completionCriteria: "远端帖子状态已确认，并在系统记录远端 ID 或失败原因。", continuationStep: "确认成功则标记发布；确认失败后由运营者决定是否创建新任务。" } }),
      db.inAppNotification.create({ data: { clientId, severity: "URGENT", title: "发布任务需要人工处理", body: reason, relatedType: "ContentItem", relatedId: contentItemId } }),
    ]);
  }
}
