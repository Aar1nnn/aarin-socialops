import { ApprovalDecision, ClientMode, ContentStatus, Prisma, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { resolveAccountPublishingMode } from "../lib/manual-account";
import { OPEN_MANUAL_TASK_STATUSES } from "../lib/publishing-status";
import { sha256 } from "../lib/security";
import { zonedLocalDateTimeToUtc } from "../lib/timezone";

const manualResultSchema = z.object({
  expectedContentVersionId: z.string().min(1),
  expectedJobStatus: z.enum(["MANUAL_PENDING", "UNKNOWN"]),
  outcome: z.enum(["PUBLISHED", "FAILED", "UNKNOWN"]),
  publishedAt: z.coerce.date().optional(),
  publishedLocalDateTime: z.string().optional(),
  timezone: z.string().optional(),
  remotePostUrl: z.url().max(2000).optional(),
  evidence: z.string().trim().min(1).max(4000),
  confirmedNoExternalPost: z.preprocess((value) => value === "on" || value === "true" ? true : value === "false" ? false : value, z.boolean().optional()),
}).superRefine((value, context) => {
  if (value.remotePostUrl && new URL(value.remotePostUrl).protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["remotePostUrl"], message: "帖子 URL 必须使用 HTTPS。" });
  }
  if (value.outcome === "PUBLISHED") {
    if (!value.publishedAt && !value.publishedLocalDateTime) context.addIssue({ code: "custom", path: ["publishedAt"], message: "请填写实际发布时间。" });
    if (value.publishedAt && value.publishedLocalDateTime) context.addIssue({ code: "custom", path: ["publishedAt"], message: "只能使用一种时间格式。" });
    if (!value.remotePostUrl) context.addIssue({ code: "custom", path: ["remotePostUrl"], message: "请填写已确认帖子的 URL。" });
    if (value.publishedAt && value.publishedAt.getTime() > Date.now()) {
      context.addIssue({ code: "custom", path: ["publishedAt"], message: "实际发布时间不能在未来。" });
    }
  }
  if (value.outcome === "FAILED") {
    if (value.confirmedNoExternalPost !== true) {
      context.addIssue({ code: "custom", path: ["confirmedNoExternalPost"], message: "只有确认没有创建外部帖子才能标记失败；不确定时请选择 UNKNOWN。" });
    }
    if (value.publishedAt || value.publishedLocalDateTime || value.remotePostUrl) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "确认未发布时不能填写帖子时间或 URL。" });
    }
  }
});

function resultFingerprint(input: z.infer<typeof manualResultSchema>, publishedAt: Date | null) {
  return sha256(JSON.stringify({
    outcome: input.outcome,
    publishedAt: publishedAt?.toISOString() ?? null,
    remotePostUrl: input.remotePostUrl ? new URL(input.remotePostUrl).toString() : null,
    evidence: input.evidence,
    confirmedNoExternalPost: input.confirmedNoExternalPost === true,
  }));
}

export async function recordManualPublishResult(context: RequestContext, jobId: string, raw: unknown) {
  assertCanWrite(context);
  const input = manualResultSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${context.clientId} FOR SHARE`;
    const client = await tx.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { mode: true, timezone: true } });
    if (client.mode !== ClientMode.LIVE) throw new AppError("只有正式客户可记录真实人工发布结果。", 409, "LIVE_MODE_REQUIRED");
    if (input.timezone && input.timezone !== client.timezone) throw new AppError("客户时区已变化，请刷新。", 409, "SCHEDULE_TIMEZONE_MISMATCH");
    const publishedAt = input.publishedLocalDateTime
      ? zonedLocalDateTimeToUtc(input.publishedLocalDateTime, client.timezone)
      : input.publishedAt ?? null;
    if (publishedAt && publishedAt.getTime() > Date.now()) throw new AppError("实际发布时间不能在未来。", 400, "INVALID_PUBLISHED_AT");
    const fingerprint = resultFingerprint(input, publishedAt);

    const scoped = await tx.publishJob.findFirst({
      where: { id: jobId, clientId: context.clientId },
      select: { contentVersion: { select: { contentItemId: true } } },
    });
    if (!scoped) throw new AppError("发布任务不存在或无权访问。", 404, "PUBLISH_JOB_NOT_FOUND");
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${scoped.contentVersion.contentItemId} AND "clientId" = ${context.clientId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "PublishJob" WHERE "id" = ${jobId} AND "clientId" = ${context.clientId} FOR UPDATE`;
    const job = await tx.publishJob.findFirst({
      where: { id: jobId, clientId: context.clientId },
      include: {
        account: true,
        contentVersion: { include: { item: true } },
      },
    });
    if (!job || job.adapter !== "manual" || resolveAccountPublishingMode(job.account) !== "MANUAL") {
      throw new AppError("这不是人工发布任务。", 409, "NOT_MANUAL_PUBLISH_JOB");
    }
    if (job.account.clientId !== context.clientId || job.contentVersion.clientId !== context.clientId
      || job.contentVersion.item.clientId !== context.clientId || job.accountId !== job.contentVersion.item.accountId) {
      throw new AppError("任务账号或内容客户范围不一致。", 409, "TENANT_SCOPE_MISMATCH");
    }
    if (job.contentVersionId !== input.expectedContentVersionId) {
      throw new AppError("发布内容版本已变化，请刷新。", 409, "VERSION_CONFLICT");
    }
    const prior = await tx.auditLog.findFirst({
      where: { clientId: context.clientId, entityType: "PublishJob", entityId: job.id, action: "MANUAL_PUBLISH_RESULT_RECORDED" },
      orderBy: { createdAt: "desc" },
    });
    const priorMetadata = prior?.metadata && typeof prior.metadata === "object" && !Array.isArray(prior.metadata)
      ? prior.metadata as Record<string, unknown> : null;
    if (job.status === input.outcome && priorMetadata?.resultFingerprint === fingerprint) return job;
    if (job.status !== input.expectedJobStatus) {
      throw new AppError("发布结果已被其他操作记录，请刷新。", 409, "MANUAL_RESULT_CONFLICT");
    }
    if (job.status !== PublishJobStatus.MANUAL_PENDING && job.status !== PublishJobStatus.UNKNOWN) {
      throw new AppError("任务已经终结，不能覆盖发布结果。", 409, "MANUAL_RESULT_CONFLICT");
    }
    if (job.contentVersion.item.currentVersionId !== job.contentVersionId
      || job.contentVersion.item.status !== (job.status === PublishJobStatus.UNKNOWN ? ContentStatus.UNKNOWN : ContentStatus.SCHEDULED)) {
      throw new AppError("内容状态已变化，请刷新。", 409, "STALE_OPERATION");
    }
    const approval = await tx.approval.findFirst({
      where: { clientId: context.clientId, contentVersionId: job.contentVersionId, accountId: job.accountId },
      orderBy: { createdAt: "desc" },
    });
    if (approval?.decision !== ApprovalDecision.APPROVED) {
      throw new AppError("当前版本与账号缺少有效人工批准。", 409, "APPROVAL_REQUIRED");
    }
    const task = await tx.manualTask.findFirst({
      where: { clientId: context.clientId, publishJobId: job.id, status: { in: [...OPEN_MANUAL_TASK_STATUSES] } },
      orderBy: { createdAt: "desc" },
    });
    if (!task || task.contentItemId !== job.contentVersion.item.id || task.accountId !== job.accountId) {
      throw new AppError("人工发布任务不存在或绑定已变化。", 409, "MANUAL_TASK_MISSING");
    }
    const result = {
      outcome: input.outcome,
      publishedAt: publishedAt?.toISOString() ?? null,
      remotePostUrl: input.remotePostUrl ? new URL(input.remotePostUrl).toString() : null,
      evidence: input.evidence,
      confirmedNoExternalPost: input.confirmedNoExternalPost === true,
      operatorUserId: context.userId,
      recordedAt: new Date().toISOString(),
    };
    const updated = await tx.publishJob.update({
      where: { id: job.id },
      data: {
        status: input.outcome,
        publishedAt: input.outcome === "PUBLISHED" ? publishedAt : null,
        remotePostUrl: result.remotePostUrl,
        lastErrorCode: input.outcome === "UNKNOWN" ? "MANUAL_RESULT_UNCERTAIN" : input.outcome === "FAILED" ? "MANUAL_CONFIRMED_NO_POST" : null,
        lastErrorMessage: input.outcome === "PUBLISHED" ? null : input.evidence,
      },
    });
    await tx.contentItem.update({
      where: { id: job.contentVersion.item.id },
      data: { status: input.outcome },
    });
    const sourceMaterial = task.sourceMaterial && typeof task.sourceMaterial === "object" && !Array.isArray(task.sourceMaterial)
      ? task.sourceMaterial as Prisma.JsonObject : {};
    await tx.manualTask.update({
      where: { id: task.id },
      data: {
        status: input.outcome === "UNKNOWN" ? "WAITING_EXTERNAL" : "COMPLETED",
        completedAt: input.outcome === "UNKNOWN" ? null : new Date(),
        sourceMaterial: { ...sourceMaterial, result } as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "MANUAL_PUBLISH_RESULT_RECORDED",
        entityType: "PublishJob",
        entityId: job.id,
        metadata: { ...result, previousStatus: job.status, contentVersionId: job.contentVersionId, accountId: job.accountId, resultFingerprint: fingerprint },
      },
    });
    return updated;
  });
}
