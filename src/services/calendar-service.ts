import { ContentStatus, PublishJobStatus } from "@prisma/client";
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

const protectedJobStatuses = new Set<PublishJobStatus>([
  PublishJobStatus.RUNNING,
  PublishJobStatus.PUBLISHED,
  PublishJobStatus.UNKNOWN,
  PublishJobStatus.FAILED,
  PublishJobStatus.CANCELLED,
]);

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
          approvals: { orderBy: { createdAt: "desc" }, take: 1 },
          publishJobs: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { updatedAt: "desc" }],
  });
  return items.map((item) => {
    const approval = item.currentVersion?.approvals[0];
    const job = item.currentVersion?.publishJobs[0];
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
      reschedulable: !protectedItemStatuses.has(item.status) && (!job || !protectedJobStatuses.has(job.status)),
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
      include: { currentVersion: { include: { publishJobs: true } } },
    });
    if (items.length !== new Set(input.contentItemIds).size) {
      throw new AppError("包含不存在或其他客户的内容。", 403, "CONTENT_SCOPE_VIOLATION");
    }
    for (const item of items) {
      if (protectedItemStatuses.has(item.status)) throw new AppError(`内容 ${item.id} 当前状态不允许重排。`, 409, "CALENDAR_ITEM_LOCKED");
      const jobs = item.currentVersion?.publishJobs || [];
      if (jobs.some((job) => protectedJobStatuses.has(job.status))) throw new AppError(`内容 ${item.id} 的发布任务不允许重排。`, 409, "CALENDAR_JOB_LOCKED");
    }
    for (const item of items) {
      await tx.contentItem.update({ where: { id: item.id }, data: { scheduledAt: input.scheduledAt } });
      if (item.currentVersionId) {
        await tx.publishJob.updateMany({
          where: { clientId: context.clientId, contentVersionId: item.currentVersionId, status: { in: ["PENDING", "RETRY", "WAITING_CONFIGURATION"] } },
          data: { nextAttemptAt: input.scheduledAt },
        });
      }
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
