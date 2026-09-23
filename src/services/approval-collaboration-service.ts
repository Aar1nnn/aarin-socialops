import { ApprovalDecision, ContentStatus, PublishJobStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

const requestChangesSchema = z.object({
  expectedVersionId: z.string().min(1),
  comment: z.string().trim().min(1).max(4000),
  reason: z.string().trim().max(500).optional(),
  requestedChanges: z.array(z.object({
    field: z.string().trim().max(100).optional(),
    instruction: z.string().trim().min(1).max(2000),
  })).min(1).max(100),
});

export async function requestContentChanges(context: RequestContext, contentItemId: string, raw: unknown) {
  assertCanWrite(context);
  const input = requestChangesSchema.parse(raw);
  const item = await db.contentItem.findFirst({
    where: { id: contentItemId, clientId: context.clientId },
    include: { currentVersion: true },
  });
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  if (!item.currentVersion) throw new AppError("内容版本缺失。", 409, "VERSION_MISSING");
  if (item.currentVersion.id !== input.expectedVersionId) {
    throw new AppError("审核版本已变化，请刷新后重试。", 409, "VERSION_CONFLICT");
  }
  if (item.status !== ContentStatus.REVIEW_PENDING) {
    throw new AppError("只有待审核内容可以请求修改。", 409, "NOT_REVIEW_PENDING");
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ContentItem" WHERE "id" = ${item.id} FOR UPDATE`;
    const liveItem = await tx.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    if (liveItem.currentVersionId !== input.expectedVersionId || liveItem.status !== ContentStatus.REVIEW_PENDING) {
      throw new AppError("审核对象已变化，请刷新后重试。", 409, "STALE_OPERATION");
    }
    const approval = await tx.approval.create({
      data: {
        clientId: context.clientId,
        contentVersionId: input.expectedVersionId,
        accountId: item.accountId,
        reviewerId: context.userId,
        decision: ApprovalDecision.REJECTED,
        note: input.reason || input.comment,
      },
    });
    const comment = await tx.reviewComment.create({
      data: {
        clientId: context.clientId,
        contentItemId: item.id,
        contentVersionId: input.expectedVersionId,
        reviewerId: context.userId,
        comment: input.comment,
        reason: input.reason,
        requestedChanges: input.requestedChanges as Prisma.InputJsonValue,
      },
    });
    await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersionId: input.expectedVersionId,
        status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "APPROVAL_REVOKED" },
    });
    await tx.contentItem.update({ where: { id: item.id }, data: { status: ContentStatus.CHANGES_REQUESTED } });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "CONTENT_CHANGES_REQUESTED",
        entityType: "ContentVersion",
        entityId: input.expectedVersionId,
        metadata: { commentId: comment.id, approvalId: approval.id, requestedChangeCount: input.requestedChanges.length },
      },
    });
    return { approval, comment, status: ContentStatus.CHANGES_REQUESTED };
  });
}

type TimelineEvent = {
  id: string;
  type: string;
  occurredAt: Date;
  actorId: string | null;
  contentVersionId: string | null;
  details: unknown;
};

export async function getContentTimeline(context: RequestContext, contentItemId: string) {
  const item = await db.contentItem.findFirst({
    where: { id: contentItemId, clientId: context.clientId },
    include: {
      versions: {
        include: {
          approvals: true,
          reviewComments: true,
          publishJobs: true,
        },
      },
    },
  });
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  const audits = await db.auditLog.findMany({
    where: {
      clientId: context.clientId,
      OR: [
        { entityType: "ContentItem", entityId: contentItemId },
        { entityType: "ContentVersion", entityId: { in: item.versions.map((version) => version.id) } },
        { entityType: "PublishJob", entityId: { in: item.versions.flatMap((version) => version.publishJobs.map((job) => job.id)) } },
      ],
    },
  });
  const events: TimelineEvent[] = [{
    id: `content:${item.id}`,
    type: "CONTENT_CREATED",
    occurredAt: item.createdAt,
    actorId: null,
    contentVersionId: null,
    details: { status: item.status },
  }];
  for (const version of item.versions) {
    events.push({
      id: `version:${version.id}`,
      type: "CONTENT_VERSION_CREATED",
      occurredAt: version.createdAt,
      actorId: version.createdByUserId,
      contentVersionId: version.id,
      details: { version: version.version, source: version.source, reason: version.reason, previousVersionId: version.previousVersionId },
    });
    for (const approval of version.approvals) {
      events.push({
        id: `approval:${approval.id}`,
        type: approval.decision === ApprovalDecision.APPROVED ? "CONTENT_APPROVED" : "CHANGES_REQUESTED",
        occurredAt: approval.createdAt,
        actorId: approval.reviewerId,
        contentVersionId: version.id,
        details: { note: approval.note, accountId: approval.accountId },
      });
    }
    for (const comment of version.reviewComments) {
      events.push({
        id: `comment:${comment.id}`,
        type: "REVIEW_COMMENT_CREATED",
        occurredAt: comment.createdAt,
        actorId: comment.reviewerId,
        contentVersionId: version.id,
        details: { comment: comment.comment, reason: comment.reason, requestedChanges: comment.requestedChanges },
      });
    }
    for (const job of version.publishJobs) {
      events.push({
        id: `job:${job.id}`,
        type: job.status === PublishJobStatus.PUBLISHED ? "CONTENT_PUBLISHED" : "CONTENT_SCHEDULED",
        occurredAt: job.publishedAt || job.createdAt,
        actorId: null,
        contentVersionId: version.id,
        details: { status: job.status, accountId: job.accountId, scheduledAt: job.nextAttemptAt },
      });
    }
  }
  for (const audit of audits) {
    events.push({
      id: `audit:${audit.id}`,
      type: audit.action,
      occurredAt: audit.createdAt,
      actorId: audit.userId,
      contentVersionId: audit.entityType === "ContentVersion" ? audit.entityId : null,
      details: audit.metadata,
    });
  }
  return events.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));
}

export const approvalCollaborationSchemas = { requestChanges: requestChangesSchema };
