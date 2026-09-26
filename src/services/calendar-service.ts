import { ApprovalDecision, ContentStatus, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { resolveAccountPublishingMode } from "../lib/manual-account";
import { MUTABLE_SCHEDULED_JOB_STATUSES, OPEN_MANUAL_TASK_STATUSES } from "../lib/publishing-status";
import { zonedLocalDateTimeToUtc } from "../lib/timezone";
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
  scheduledAt: z.coerce.date().optional(),
  localDateTime: z.string().optional(),
  timezone: z.string().optional(),
}).refine((input) => Boolean(input.scheduledAt) !== Boolean(input.localDateTime), {
  message: "请提供排期时间或客户时区本地时间。",
});

const protectedItemStatuses = new Set<ContentStatus>([
  ContentStatus.RUNNING,
  ContentStatus.PUBLISHED,
  ContentStatus.UNKNOWN,
  ContentStatus.FAILED,
  ContentStatus.CANCELLED,
]);

const activeJobStatuses: PublishJobStatus[] = MUTABLE_SCHEDULED_JOB_STATUSES;
const mutableJobStatuses = new Set(activeJobStatuses);

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
      account: { select: { id: true, displayName: true, platform: true, metadata: true } },
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
    const reschedulable = item.status === ContentStatus.SCHEDULED
      && approval?.decision === ApprovalDecision.APPROVED
      && Boolean(activeJob);
    const lockReason = reschedulable ? null
      : item.status !== ContentStatus.SCHEDULED ? "仅已排期内容可以拖动。"
      : approval?.decision !== ApprovalDecision.APPROVED ? "当前版本缺少有效人工批准。"
      : job ? `任务状态 ${job.status} 不允许重排。` : "当前版本没有可重排的发布任务。";
    return {
      id: item.id,
      platform: item.platform,
      accountId: item.accountId,
      accountName: item.account.displayName,
      publishingMode: job ? job.adapter === "manual" ? "MANUAL" : "API" : resolveAccountPublishingMode(item.account),
      theme: item.plan.theme,
      productName: item.plan.product?.name || null,
      title: item.currentVersion?.title || null,
      status: item.status,
      scheduledAt: item.scheduledAt,
      approvalStatus: approval?.decision || null,
      publishJobStatus: job?.status || null,
      queueAt: job?.nextAttemptAt || null,
      reschedulable,
      lockReason,
    };
  });
}

export async function rescheduleCalendarItems(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = rescheduleSchema.parse(raw);
  try {
    return await db.$transaction(async (tx) => {
      await lockSchedulingClient(tx, context.clientId);
      const client = await tx.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } });
      if (input.timezone && input.timezone !== client.timezone) {
        throw new AppError("排期时区与客户配置不一致，请刷新页面。", 409, "SCHEDULE_TIMEZONE_MISMATCH");
      }
      const scheduledAt = input.localDateTime
        ? zonedLocalDateTimeToUtc(input.localDateTime, client.timezone)
        : input.scheduledAt!;
      if (scheduledAt.getTime() <= Date.now()) throw new AppError("排期时间必须晚于当前时间。", 400, "SCHEDULE_TIME_IN_PAST");
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
        if (item.status !== ContentStatus.SCHEDULED) {
          throw new AppError(`内容 ${item.id} 不是已有排期，不能通过 Calendar 创建新排期。`, 409, "CALENDAR_ITEM_NOT_RESCHEDULABLE");
        }
      }
      for (const accountId of [...new Set(currentItems.map((item) => item.accountId))].sort()) {
        await lockSchedulingAccount(tx, context.clientId, accountId);
      }

      const validatedItems = [];
      for (const contentItemId of contentItemIds) {
        const validated = await validatePublicationInTransaction(tx, context, contentItemId, scheduledAt);
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
          scheduledAt,
          excludeContentItemIds: contentItemIds,
        });
        if (conflict.conflict) throw new AppError("该账号的目标时间附近已有排期。", 409, "SCHEDULE_CONFLICT");
      }

      for (const validated of validatedItems) {
        const updated = await tx.publishJob.updateMany({
          where: {
            id: validated.existing!.id,
            clientId: context.clientId,
            contentVersionId: validated.currentVersionId,
            accountId: validated.item.accountId,
            status: { in: activeJobStatuses },
          },
          data: { nextAttemptAt: scheduledAt },
        });
        if (updated.count !== 1) throw new AppError("发布任务已被其他操作更新，请刷新后重试。", 409, "STALE_OPERATION");
        const movedItem = await tx.contentItem.updateMany({
          where: {
            id: validated.item.id,
            clientId: context.clientId,
            status: ContentStatus.SCHEDULED,
            currentVersionId: validated.currentVersionId,
            accountId: validated.item.accountId,
          },
          data: { scheduledAt },
        });
        if (movedItem.count !== 1) throw new AppError(`内容 ${validated.item.id} 的排期状态已变化。`, 409, "CALENDAR_ITEM_LOCKED");
        if (validated.existing!.status === PublishJobStatus.MANUAL_PENDING) {
          await tx.manualTask.updateMany({
            where: { clientId: context.clientId, publishJobId: validated.existing!.id, status: { in: [...OPEN_MANUAL_TASK_STATUSES] } },
            data: { suggestedDueAt: scheduledAt },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          clientId: context.clientId,
          userId: context.userId,
          action: contentItemIds.length > 1 ? "CALENDAR_BULK_RESCHEDULED" : "CALENDAR_ITEM_RESCHEDULED",
          entityType: "ContentItem",
          metadata: { contentItemIds, scheduledAt: scheduledAt.toISOString() },
        },
      });
      return { updated: validatedItems.length, scheduledAt };
    });
  } catch (error) {
    await persistPublicationGateTask(context.clientId, error);
    throw error;
  }
}
