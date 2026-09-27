import { ContentStatus, Prisma, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { assertValidTimeZone, zonedLocalDateTimeToUtc } from "../lib/timezone";
import { recordDomainEvent } from "../lib/domain-events";
import { MUTABLE_SCHEDULED_JOB_STATUSES } from "../lib/publishing-status";
import { rescheduleCalendarItems } from "./calendar-service";
import {
  findScheduleConflictsInTransaction,
  lockContentItemForScheduling,
  lockSchedulingAccount,
  lockSchedulingClient,
  persistPublicationGateTask,
  schedulePublicationInTransaction,
  validatePublicationInTransaction,
} from "./content-service";

const slotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59).default(0),
  enabled: z.boolean().default(true),
});

const queueSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  horizonDays: z.number().int().min(1).max(90).default(30),
  slots: z.array(slotSchema).min(1).max(100),
});

const conflictSchema = z.object({
  accountId: z.string().min(1),
  scheduledAt: z.coerce.date(),
  excludeContentItemId: z.string().min(1).optional(),
  windowMinutes: z.number().int().min(0).max(1440).default(5),
});

const assignSchema = z.object({
  queueId: z.string().min(1),
  contentItemId: z.string().min(1),
  after: z.coerce.date().optional(),
});

const mutableJobStatuses = new Set<PublishJobStatus>(MUTABLE_SCHEDULED_JOB_STATUSES);
const immutableItemStatuses = new Set<ContentStatus>([ContentStatus.RUNNING, ContentStatus.PUBLISHED, ContentStatus.UNKNOWN, ContentStatus.FAILED, ContentStatus.CANCELLED]);

function datePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), dayOfWeek: date.getUTCDay() };
}

function pad(value: number) { return String(value).padStart(2, "0"); }

function queueOccurrences(
  queue: { timezone: string; horizonDays: number; slots: Array<{ dayOfWeek: number; hour: number; minute: number }> },
  after: Date,
) {
  const start = datePartsInZone(after, queue.timezone);
  const occurrences: Date[] = [];
  for (let offset = 0; offset <= queue.horizonDays; offset += 1) {
    const localDate = addLocalDays(start, offset);
    for (const slot of queue.slots.filter((candidate) => candidate.dayOfWeek === localDate.dayOfWeek)) {
      const localDateTime = `${localDate.year}-${pad(localDate.month)}-${pad(localDate.day)}T${pad(slot.hour)}:${pad(slot.minute)}:00`;
      try {
        const instant = zonedLocalDateTimeToUtc(localDateTime, queue.timezone);
        if (instant.getTime() > after.getTime()) occurrences.push(instant);
      } catch (error) {
        if (error instanceof AppError && ["INVALID_SCHEDULE_TIME", "AMBIGUOUS_SCHEDULE_TIME"].includes(error.code)) continue;
        throw error;
      }
    }
  }
  return occurrences.sort((left, right) => left.getTime() - right.getTime());
}

export async function upsertScheduleQueue(context: RequestContext, queueId: string | null, raw: unknown) {
  assertCanWrite(context);
  const input = queueSchema.parse(raw);
  assertValidTimeZone(input.timezone);
  const [account, client] = await Promise.all([
    db.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId } }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  if (!account) throw new AppError("账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
  if (client.timezone !== input.timezone) throw new AppError("排期队列时区必须与客户时区一致。", 409, "SCHEDULE_TIMEZONE_MISMATCH");
  if (queueId) {
    const existing = await db.scheduleQueue.findFirst({ where: { id: queueId, clientId: context.clientId } });
    if (!existing) throw new AppError("排期队列不存在或无权访问。", 404, "SCHEDULE_QUEUE_NOT_FOUND");
  }
  return db.$transaction(async (tx) => {
    const queue = queueId
      ? await tx.scheduleQueue.update({ where: { id: queueId }, data: { accountId: input.accountId, name: input.name, timezone: input.timezone, enabled: input.enabled, horizonDays: input.horizonDays } })
      : await tx.scheduleQueue.create({ data: { clientId: context.clientId, accountId: input.accountId, name: input.name, timezone: input.timezone, enabled: input.enabled, horizonDays: input.horizonDays } });
    await tx.scheduleSlot.deleteMany({ where: { queueId: queue.id, clientId: context.clientId } });
    await tx.scheduleSlot.createMany({ data: input.slots.map((slot) => ({ ...slot, clientId: context.clientId, queueId: queue.id })) });
    await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: queueId ? "SCHEDULE_QUEUE_UPDATED" : "SCHEDULE_QUEUE_CREATED", entityType: "ScheduleQueue", entityId: queue.id } });
    return tx.scheduleQueue.findUniqueOrThrow({ where: { id: queue.id }, include: { slots: { orderBy: [{ dayOfWeek: "asc" }, { hour: "asc" }, { minute: "asc" }] } } });
  });
}

export async function listScheduleQueues(context: RequestContext) {
  return db.scheduleQueue.findMany({
    where: { clientId: context.clientId },
    include: { account: { select: { id: true, platform: true, displayName: true } }, slots: { orderBy: [{ dayOfWeek: "asc" }, { hour: "asc" }, { minute: "asc" }] } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function getQueueOccurrences(context: RequestContext, queueId: string, after = new Date()) {
  const queue = await db.scheduleQueue.findFirst({
    where: { id: queueId, clientId: context.clientId, enabled: true },
    include: { slots: { where: { enabled: true } } },
  });
  if (!queue) throw new AppError("排期队列不存在、无权访问或已停用。", 404, "SCHEDULE_QUEUE_NOT_FOUND");
  return queueOccurrences(queue, after);
}

export async function detectScheduleConflict(context: RequestContext, raw: unknown) {
  const input = conflictSchema.parse(raw);
  const account = await db.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId }, select: { id: true } });
  if (!account) throw new AppError("账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
  return db.$transaction((tx) => findScheduleConflictsInTransaction(tx, {
    clientId: context.clientId,
    accountId: input.accountId,
    scheduledAt: input.scheduledAt,
    excludeContentItemIds: input.excludeContentItemId ? [input.excludeContentItemId] : [],
    windowMinutes: input.windowMinutes,
  }));
}

async function lockScheduleQueue(tx: Prisma.TransactionClient, context: RequestContext, queueId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; accountId: string }>>`
    SELECT "id", "accountId" FROM "ScheduleQueue"
    WHERE "id" = ${queueId} AND "clientId" = ${context.clientId} AND "enabled" = true
    FOR UPDATE
  `;
  if (!rows.length) throw new AppError("排期队列不存在、无权访问或已停用。", 404, "SCHEDULE_QUEUE_NOT_FOUND");
  return rows[0];
}

async function assignContentToQueueInTransaction(
  tx: Prisma.TransactionClient,
  context: RequestContext,
  input: z.infer<typeof assignSchema>,
) {
  await lockSchedulingClient(tx, context.clientId);
  const lockedQueue = await lockScheduleQueue(tx, context, input.queueId);
  const lockedItem = await lockContentItemForScheduling(tx, context, input.contentItemId);
  if (lockedItem.accountId !== lockedQueue.accountId) {
    throw new AppError("内容账号与排期队列账号不一致。", 409, "SCHEDULE_QUEUE_ACCOUNT_MISMATCH");
  }
  await lockSchedulingAccount(tx, context.clientId, lockedQueue.accountId);
  const [queue, item] = await Promise.all([
    tx.scheduleQueue.findFirst({
      where: { id: lockedQueue.id, clientId: context.clientId, enabled: true },
      include: { slots: { where: { enabled: true } } },
    }),
    tx.contentItem.findFirst({
      where: { id: lockedItem.id, clientId: context.clientId },
      select: { id: true, accountId: true, currentVersionId: true, status: true, scheduledAt: true },
    }),
  ]);
  if (!queue) throw new AppError("排期队列不存在、无权访问或已停用。", 404, "SCHEDULE_QUEUE_NOT_FOUND");
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  if (item.accountId !== queue.accountId) throw new AppError("内容账号与排期队列账号不一致。", 409, "SCHEDULE_QUEUE_ACCOUNT_MISMATCH");
  if (immutableItemStatuses.has(item.status)) throw new AppError("内容当前状态不允许排期或重排。", 409, "CALENDAR_ITEM_LOCKED");

  const existing = item.currentVersionId
    ? await tx.publishJob.findUnique({
        where: { clientId_contentVersionId_accountId: { clientId: context.clientId, contentVersionId: item.currentVersionId, accountId: item.accountId } },
      })
    : null;
  if (existing && mutableJobStatuses.has(existing.status)) {
    const persistedAt = item.scheduledAt || existing.nextAttemptAt;
    await validatePublicationInTransaction(tx, context, item.id, persistedAt);
    return { contentItemId: item.id, queueId: queue.id, scheduledAt: persistedAt, publishJobId: existing.id, changed: false };
  }
  if (existing && !(existing.status === PublishJobStatus.CANCELLED && existing.attemptCount === 0)) {
    throw new AppError("现有发布任务状态不允许重新排期。", 409, "CALENDAR_JOB_LOCKED");
  }

  let scheduledAt: Date | null = null;
  for (const candidate of queueOccurrences(queue, input.after || new Date())) {
    const conflict = await findScheduleConflictsInTransaction(tx, {
      clientId: context.clientId,
      accountId: queue.accountId,
      scheduledAt: candidate,
      excludeContentItemIds: [item.id],
    });
    if (!conflict.conflict) {
      scheduledAt = candidate;
      break;
    }
  }
  if (!scheduledAt) throw new AppError("队列计划周期内没有可用排期槽位。", 409, "NO_AVAILABLE_SCHEDULE_SLOT");
  const scheduled = await schedulePublicationInTransaction(tx, context, item.id, {
    publishMode: "SCHEDULED",
    localDateTime: formatLocalDateTime(scheduledAt, queue.timezone),
    timezone: queue.timezone,
  });
  if (!scheduled.changed) {
    return { contentItemId: item.id, queueId: queue.id, scheduledAt: scheduled.scheduledAt, publishJobId: scheduled.job.id, changed: false };
  }
  await recordDomainEvent(context, {
    type: "CONTENT_SCHEDULED",
    entityType: "ContentItem",
    entityId: item.id,
    metadata: { queueId: queue.id, scheduledAt: scheduled.scheduledAt.toISOString() },
  }, tx);
  return { contentItemId: item.id, queueId: queue.id, scheduledAt: scheduled.scheduledAt, publishJobId: scheduled.job.id, changed: true };
}

export async function findNextAvailableSlot(context: RequestContext, queueId: string, after = new Date(), excludeContentItemId?: string) {
  const queue = await db.scheduleQueue.findFirst({ where: { id: queueId, clientId: context.clientId }, select: { accountId: true } });
  if (!queue) throw new AppError("排期队列不存在或无权访问。", 404, "SCHEDULE_QUEUE_NOT_FOUND");
  for (const scheduledAt of await getQueueOccurrences(context, queueId, after)) {
    const result = await detectScheduleConflict(context, { accountId: queue.accountId, scheduledAt, excludeContentItemId });
    if (!result.conflict) return scheduledAt;
  }
  throw new AppError("队列计划周期内没有可用排期槽位。", 409, "NO_AVAILABLE_SCHEDULE_SLOT");
}

export async function assignContentToQueue(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = assignSchema.parse(raw);
  try {
    const result = await db.$transaction((tx) => assignContentToQueueInTransaction(tx, context, input));
    const { changed: _changed, ...response } = result;
    return response;
  } catch (error) {
    await persistPublicationGateTask(context.clientId, error);
    throw error;
  }
}

function formatLocalDateTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

export async function bulkRescheduleWithResults(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = z.object({ operations: z.array(z.object({ contentItemId: z.string().min(1), scheduledAt: z.coerce.date() })).min(1).max(100) }).parse(raw);
  const results: Array<{ contentItemId: string; status: "UPDATED" | "REJECTED"; scheduledAt?: Date; error?: { code: string; message: string } }> = [];
  for (const operation of input.operations) {
    try {
      await rescheduleCalendarItems(context, { contentItemIds: [operation.contentItemId], scheduledAt: operation.scheduledAt });
      results.push({ contentItemId: operation.contentItemId, status: "UPDATED", scheduledAt: operation.scheduledAt });
    } catch (error) {
      const known = error instanceof AppError ? error : new AppError("Unexpected reschedule failure.", 500, "RESCHEDULE_FAILED");
      results.push({ contentItemId: operation.contentItemId, status: "REJECTED", error: { code: known.code, message: known.message } });
    }
  }
  return { updated: results.filter((result) => result.status === "UPDATED").length, rejected: results.filter((result) => result.status === "REJECTED").length, results };
}

export const scheduleQueueSchemas = { queue: queueSchema, slot: slotSchema, conflict: conflictSchema, assign: assignSchema };
