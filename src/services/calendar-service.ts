import { ApprovalDecision, ContentStatus, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

const activeJobStatuses = [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION];

export const calendarFiltersSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  platform: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  status: z.nativeEnum(ContentStatus).optional(),
}).refine((value) => value.to > value.from, { message: "Calendar end must be after start." });

const rescheduleInputSchema = z.object({
  contentItemId: z.string().min(1),
  scheduledAt: z.coerce.date(),
});

const bulkRescheduleSchema = z.object({
  changes: z.array(rescheduleInputSchema).min(1).max(100),
}).superRefine((value, ctx) => {
  const ids = value.changes.map((change) => change.contentItemId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Each content item may appear only once." });
});

export async function listCalendarEntries(context: RequestContext, raw: unknown) {
  const filters = calendarFiltersSchema.parse(raw);
  return db.contentItem.findMany({
    where: {
      clientId: context.clientId,
      scheduledAt: { gte: filters.from, lt: filters.to },
      ...(filters.platform ? { platform: filters.platform } : {}),
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    include: {
      account: { select: { id: true, platform: true, displayName: true } },
      plan: { select: { id: true, theme: true, objective: true, plannedAt: true } },
      currentVersion: {
        select: {
          id: true,
          version: true,
          title: true,
          text: true,
          approvals: { orderBy: { createdAt: "desc" }, take: 1, select: { decision: true, createdAt: true } },
          publishJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, nextAttemptAt: true } },
        },
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
  });
}

export async function rescheduleCalendarItem(context: RequestContext, contentItemId: string, scheduledAt: Date) {
  const result = await bulkRescheduleCalendarItems(context, { changes: [{ contentItemId, scheduledAt }] });
  return result[0];
}

export async function bulkRescheduleCalendarItems(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = bulkRescheduleSchema.parse(raw);
  const now = new Date();
  if (input.changes.some((change) => change.scheduledAt <= now)) {
    throw new AppError("Calendar reschedule time must be in the future.", 400, "SCHEDULE_TIME_IN_PAST");
  }
  return db.$transaction(async (tx) => {
    const items = await tx.contentItem.findMany({
      where: { clientId: context.clientId, id: { in: input.changes.map((change) => change.contentItemId) } },
      include: {
        currentVersion: {
          include: {
            approvals: { where: { accountId: { not: undefined } }, orderBy: { createdAt: "desc" } },
            publishJobs: { where: { status: { in: activeJobStatuses } }, orderBy: { createdAt: "desc" } },
          },
        },
      },
    });
    if (items.length !== input.changes.length) throw new AppError("One or more calendar items were not found in this client.", 404, "CALENDAR_ITEM_NOT_FOUND");
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const change of input.changes) {
      const item = byId.get(change.contentItemId)!;
      if (item.status !== ContentStatus.SCHEDULED || !item.currentVersion) {
        throw new AppError("Only an existing scheduled current version can be rescheduled.", 409, "CALENDAR_NOT_RESCHEDULABLE");
      }
      const approval = item.currentVersion.approvals.find((candidate) => candidate.accountId === item.accountId);
      if (!approval || approval.decision !== ApprovalDecision.APPROVED) {
        throw new AppError("Current version no longer has a valid human approval.", 409, "APPROVAL_REQUIRED");
      }
      const job = item.currentVersion.publishJobs.find((candidate) => candidate.accountId === item.accountId);
      if (!job) throw new AppError("The existing scheduled item has no movable publish job.", 409, "PUBLISH_JOB_REQUIRED");
    }
    const updated = [];
    for (const change of input.changes) {
      const item = byId.get(change.contentItemId)!;
      const job = item.currentVersion!.publishJobs.find((candidate) => candidate.accountId === item.accountId)!;
      await tx.publishJob.update({ where: { id: job.id }, data: { nextAttemptAt: change.scheduledAt } });
      const moved = await tx.contentItem.update({ where: { id: item.id }, data: { scheduledAt: change.scheduledAt } });
      await tx.auditLog.create({
        data: {
          clientId: context.clientId,
          userId: context.userId,
          action: "CALENDAR_ITEM_RESCHEDULED",
          entityType: "ContentItem",
          entityId: item.id,
          metadata: { previousScheduledAt: item.scheduledAt, scheduledAt: change.scheduledAt, publishJobId: job.id },
        },
      });
      updated.push(moved);
    }
    return updated;
  });
}
