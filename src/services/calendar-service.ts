import { ApprovalDecision, ContentStatus, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";
import {
  findScheduleConflictsInTransaction,
  lockContentItemForScheduling,
  lockSchedulingAccount,
  lockSchedulingClient,
  persistPublicationGateTask,
  validatePublicationInTransaction,
} from "./content-service";

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

const mutableJobStatuses = new Set<PublishJobStatus>([
  PublishJobStatus.PENDING,
  PublishJobStatus.RETRY,
  PublishJobStatus.WAITING_CONFIGURATION,
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
      reschedulable: approval?.decision === ApprovalDecision.APPROVED
        && !protectedItemStatuses.has(item.status)
        && Boolean(job && mutableJobStatuses.has(job.status)),
    };
  });
}

export async function rescheduleCalendarItems(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = rescheduleSchema.parse(raw);
  if (input.scheduledAt.getTime() <= Date.now()) throw new AppError("排期时间必须晚于当前时间。", 400, "SCHEDULE_TIME_IN_PAST");
  try {
    return await db.$transaction(async (tx) => {
      await lockSchedulingClient(tx, context.clientId);
      const contentItemIds = [...new Set(input.contentItemIds)];
      const scopedItems = await tx.contentItem.findMany({
        where: { clientId: context.clientId, id: { in: contentItemIds } },
        select: { id: true },
      });
      if (scopedItems.length !== contentItemIds.length) {
        throw new AppError("包含不存在或其他客户的内容。", 403, "CONTENT_SCOPE_VIOLATION");
      }
      for (const contentItemId of [...contentItemIds].sort()) {
        await lockContentItemForScheduling(tx, context, contentItemId);
      }
      const currentItems = await tx.contentItem.findMany({
        where: { clientId: context.clientId, id: { in: contentItemIds } },
        select: { id: true, accountId: true, status: true },
      });
      for (const item of currentItems) {
        if (protectedItemStatuses.has(item.status)) {
          throw new AppError(`内容 ${item.id} 当前状态不允许重排。`, 409, "CALENDAR_ITEM_LOCKED");
        }
      }
      for (const accountId of [...new Set(currentItems.map((item) => item.accountId))].sort()) {
        await lockSchedulingAccount(tx, context.clientId, accountId);
      }

      const validatedItems = [];
      for (const contentItemId of contentItemIds) {
        const validated = await validatePublicationInTransaction(tx, context, contentItemId, input.scheduledAt);
        if (!validated.existing || !mutableJobStatuses.has(validated.existing.status)) {
          throw new AppError(`内容 ${contentItemId} 没有可重排的当前发布任务。`, 409, "CALENDAR_JOB_LOCKED");
        }
        validatedItems.push(validated);
      }

      const accountIds = validatedItems.map((validated) => validated.item.accountId);
      if (new Set(accountIds).size !== accountIds.length) {
        throw new AppError("同一账号的多条内容不能重排到同一时间。", 409, "SCHEDULE_CONFLICT");
      }
      for (const validated of validatedItems) {
        const conflict = await findScheduleConflictsInTransaction(tx, {
          clientId: context.clientId,
          accountId: validated.item.accountId,
          scheduledAt: input.scheduledAt,
          excludeContentItemIds: contentItemIds,
        });
        if (conflict.conflict) throw new AppError("该账号的目标时间附近已有排期。", 409, "SCHEDULE_CONFLICT");
      }

      for (const validated of validatedItems) {
        const updated = await tx.publishJob.updateMany({
          where: { id: validated.existing!.id, clientId: context.clientId, status: { in: [...mutableJobStatuses] } },
          data: { nextAttemptAt: input.scheduledAt },
        });
        if (updated.count !== 1) throw new AppError("发布任务已被其他操作更新，请刷新后重试。", 409, "STALE_OPERATION");
        await tx.contentItem.update({
          where: { id: validated.item.id },
          data: { scheduledAt: input.scheduledAt, status: ContentStatus.SCHEDULED },
        });
      }
      await tx.auditLog.create({
        data: {
          clientId: context.clientId,
          userId: context.userId,
          action: contentItemIds.length > 1 ? "CALENDAR_BULK_RESCHEDULED" : "CALENDAR_ITEM_RESCHEDULED",
          entityType: "ContentItem",
          metadata: { contentItemIds, scheduledAt: input.scheduledAt.toISOString() },
        },
      });
      return { updated: validatedItems.length, scheduledAt: input.scheduledAt };
    });
  } catch (error) {
    await persistPublicationGateTask(context.clientId, error);
    throw error;
  }
}
