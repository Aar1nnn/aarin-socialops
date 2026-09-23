import { ContentStatus, PublishJobStatus } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { assertValidTimeZone, zonedLocalDateTimeToUtc } from "../lib/timezone";
import { recordDomainEvent } from "../lib/domain-events";
import { rescheduleCalendarItems } from "./calendar-service";
import { schedulePublication } from "./content-service";

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

const activeItemStatuses: ContentStatus[] = [ContentStatus.APPROVED, ContentStatus.SCHEDULED, ContentStatus.REVIEW_PENDING];
const activeJobStatuses: PublishJobStatus[] = [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION, PublishJobStatus.RUNNING];

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
  const start = datePartsInZone(after, queue.timezone);
  const occurrences: Date[] = [];
  for (let offset = 0; offset <= queue.horizonDays; offset += 1) {
    const localDate = addLocalDays(start, offset);
    for (const slot of queue.slots.filter((candidate) => candidate.dayOfWeek === localDate.dayOfWeek)) {
      const localDateTime = `${localDate.year}-${pad(localDate.month)}-${pad(localDate.day)}T${pad(slot.hour)}:${pad(slot.minute)}:00`;
      const instant = zonedLocalDateTimeToUtc(localDateTime, queue.timezone);
      if (instant.getTime() > after.getTime()) occurrences.push(instant);
    }
  }
  return occurrences.sort((left, right) => left.getTime() - right.getTime());
}

export async function detectScheduleConflict(context: RequestContext, raw: unknown) {
  const input = conflictSchema.parse(raw);
  const account = await db.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId }, select: { id: true } });
  if (!account) throw new AppError("账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
  const from = new Date(input.scheduledAt.getTime() - input.windowMinutes * 60_000);
  const to = new Date(input.scheduledAt.getTime() + input.windowMinutes * 60_000);
  const conflicts = await db.contentItem.findMany({
    where: {
      clientId: context.clientId,
      accountId: input.accountId,
      ...(input.excludeContentItemId ? { id: { not: input.excludeContentItemId } } : {}),
      OR: [
        { status: { in: activeItemStatuses }, scheduledAt: { gte: from, lte: to } },
        { currentVersion: { publishJobs: { some: { clientId: context.clientId, status: { in: activeJobStatuses }, nextAttemptAt: { gte: from, lte: to } } } } },
      ],
    },
    select: { id: true, status: true, scheduledAt: true, accountId: true, platform: true },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  return { conflict: conflicts.length > 0, conflicts, window: { from, to } };
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
  const [queue, item] = await Promise.all([
    db.scheduleQueue.findFirst({ where: { id: input.queueId, clientId: context.clientId, enabled: true } }),
    db.contentItem.findFirst({ where: { id: input.contentItemId, clientId: context.clientId } }),
  ]);
  if (!queue) throw new AppError("排期队列不存在、无权访问或已停用。", 404, "SCHEDULE_QUEUE_NOT_FOUND");
  if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
  if (item.accountId !== queue.accountId) throw new AppError("内容账号与排期队列账号不一致。", 409, "SCHEDULE_QUEUE_ACCOUNT_MISMATCH");
  const scheduledAt = await findNextAvailableSlot(context, queue.id, input.after || new Date(), item.id);
  const job = await schedulePublication(context, item.id, { publishMode: "SCHEDULED", localDateTime: formatLocalDateTime(scheduledAt, queue.timezone), timezone: queue.timezone });
  await recordDomainEvent(context, { type: "CONTENT_SCHEDULED", entityType: "ContentItem", entityId: item.id, metadata: { queueId: queue.id, scheduledAt: scheduledAt.toISOString() } });
  return { contentItemId: item.id, queueId: queue.id, scheduledAt, publishJobId: job.id };
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
