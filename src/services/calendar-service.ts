import { ApprovalDecision, ContentStatus, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";

const calendarFilterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  platform: z.string().optional(),
  accountId: z.string().optional(),
  status: z.nativeEnum(ContentStatus).optional(),
  view: z.enum(["month", "week", "list"]).default("month"),
});

const rescheduleSchema = z.object({
  contentItemIds: z.array(z.string().min(1)).min(1).max(100),
  scheduledAt: z.coerce.date(),
});

const protectedItemStatuses = new Set<ContentStatus>([
  ContentStatus.RUNNING,
  ContentStatus.PUBLISHED,
  ContentStatus.UNKNOWN,
  ContentStatus.FAILED,
  ContentStatus.CANCELLED,
]);

const activeJobStatuses: PublishJobStatus[] = [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION];

export async function listCalendarEntries(context: RequestContext, raw: unknown = {}) {
  const input = calendarFilterSchema.parse(raw);
  const scheduledAt = input.from || input.to ? {
    ...(input.from ? { gte: input.from } : {}),
    ...(input.to ? { lt: input.to } : {}),
  } : undefined;
  const items = await db.contentItem.findMany({
    where: {
      clientId: context.clientId,
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    include: {
      account: { select: { id: true, displayName: true, platform: true } },
      plan: { include: { product: { select: { id: true, name: true } } } },
      currentVersion: {
        include: {
          approvals: { orderBy: { createdAt: "desc" } },
          publishJobs: { orderBy: { createdAt: "desc" } },
        },
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { updatedAt: "desc" }],
  });
  return items.map((item) => {
    const approval = item.currentVersion?.approvals.find((candidate) => candidate.accountId === item.accountId);
    const job = item.currentVersion?.publishJobs.find((candidate) => candidate.accountId === item.accountId);
    const activeJob = item.currentVersion?.publishJobs.find((candidate) => candidate.accountId === item.accountId && activeJobStatuses.includes(candidate.status));
    return {
      id: item.id,
      platform: item.platform,
      accountId: item.accountId,
      accountName: item.account.displayName,
      theme: item.plan.theme,
      productName: item.plan.product?.name || null,
      title: item.currentVersion?.title || null,
      status: item.status,
      scheduledAt: item.scheduledAt,
      approvalStatus: approval?.decision || null,
      publishJobStatus: job?.status || null,
      queueAt: job?.nextAttemptAt || null,
      reschedulable: item.status === ContentStatus.SCHEDULED
        && approval?.decision === ApprovalDecision.APPROVED
        && Boolean(activeJob),
    };
  });
}

export async function rescheduleCalendarItems(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = rescheduleSchema.parse(raw);
  if (input.scheduledAt.getTime() <= Date.now()) throw new AppError("排期时间必须晚于当前时间。", 400, "SCHEDULE_TIME_IN_PAST");
  return db.$transaction(async (tx) => {
    const items = await tx.contentItem.findMany({
      where: { clientId: context.clientId, id: { in: input.contentItemIds } },
      include: {
        currentVersion: {
          include: {
            approvals: { orderBy: { createdAt: "desc" } },
            publishJobs: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    });
    if (items.length !== new Set(input.contentItemIds).size) {
      throw new AppError("包含不存在或其他客户的内容。", 403, "CONTENT_SCOPE_VIOLATION");
    }
    for (const item of items) {
      if (protectedItemStatuses.has(item.status)) throw new AppError(`内容 ${item.id} 当前状态不允许重排。`, 409, "CALENDAR_ITEM_LOCKED");
      if (item.status !== ContentStatus.SCHEDULED || !item.currentVersion) {
        throw new AppError(`内容 ${item.id} 不是已有排期，不能通过 Calendar 创建新排期。`, 409, "CALENDAR_ITEM_NOT_RESCHEDULABLE");
      }
      const approval = item.currentVersion.approvals.find((candidate) => candidate.accountId === item.accountId);
      if (!approval || approval.decision !== ApprovalDecision.APPROVED) {
        throw new AppError(`内容 ${item.id} 的当前版本没有有效人工批准。`, 409, "APPROVAL_REQUIRED");
      }
      const job = item.currentVersion.publishJobs.find((candidate) => candidate.accountId === item.accountId && activeJobStatuses.includes(candidate.status));
      if (!job) throw new AppError(`内容 ${item.id} 没有可移动的现有发布任务。`, 409, "PUBLISH_JOB_REQUIRED");
    }
    for (const item of items) {
      const job = item.currentVersion!.publishJobs.find((candidate) => candidate.accountId === item.accountId && activeJobStatuses.includes(candidate.status))!;
      const movedItem = await tx.contentItem.updateMany({
        where: { id: item.id, clientId: context.clientId, status: ContentStatus.SCHEDULED, currentVersionId: item.currentVersionId, accountId: item.accountId },
        data: { scheduledAt: input.scheduledAt },
      });
      if (movedItem.count !== 1) throw new AppError(`内容 ${item.id} 的排期状态已变化。`, 409, "CALENDAR_ITEM_LOCKED");
      const movedJob = await tx.publishJob.updateMany({
        where: { id: job.id, clientId: context.clientId, contentVersionId: item.currentVersionId!, accountId: item.accountId, status: { in: activeJobStatuses } },
        data: { nextAttemptAt: input.scheduledAt },
      });
      if (movedJob.count !== 1) throw new AppError(`内容 ${item.id} 的发布任务状态已变化。`, 409, "CALENDAR_JOB_LOCKED");
    }
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: input.contentItemIds.length > 1 ? "CALENDAR_BULK_RESCHEDULED" : "CALENDAR_ITEM_RESCHEDULED",
        entityType: "ContentItem",
        metadata: { contentItemIds: input.contentItemIds, scheduledAt: input.scheduledAt.toISOString() },
      },
    });
    return { updated: items.length, scheduledAt: input.scheduledAt };
  });
}
