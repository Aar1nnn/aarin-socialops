import { NotificationSeverity, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

export const notificationEventTypes = [
  "PUBLISH_FAILED", "PUBLISH_UNKNOWN", "CONNECTION_ERROR", "TOKEN_EXPIRING", "TOKEN_EXPIRED",
  "PERMISSION_MISSING", "PLATFORM_DISCONNECTED", "URGENT_LEAD", "HIGH_PRIORITY_TASK",
] as const;
export const notificationChannelTypes = ["IN_APP", "EMAIL", "WEBHOOK"] as const;
const externalNotificationChannelTypes = ["EMAIL", "WEBHOOK"] as const;

const notificationEventSchema = z.object({
  eventType: z.enum(notificationEventTypes),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  relatedType: z.string().max(100).optional(),
  relatedId: z.string().max(200).optional(),
  urgent: z.boolean().default(false),
  dedupeKey: z.string().trim().min(1).max(300).optional(),
});
const notificationRuleSchema = z.object({
  eventType: z.enum(notificationEventTypes),
  severity: z.nativeEnum(NotificationSeverity),
  channelType: z.enum(notificationChannelTypes),
  enabled: z.boolean().default(true),
  cooldownMinutes: z.number().int().min(0).max(7 * 24 * 60).default(60),
});
const inboxFilterSchema = z.object({
  view: z.enum(["unread", "important", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type NotificationEvent = z.input<typeof notificationEventSchema>;
export type ExternalNotificationPayload = { title: string; body: string; eventType: string; relatedType?: string; relatedId?: string };
export type NotificationTransport = (input: { type: string; endpoint: string; displayName: string; payload: ExternalNotificationPayload }) => Promise<void>;

function resolveCredentialRef(ref: string | null) {
  if (!ref?.startsWith("env:")) return null;
  const key = ref.slice(4);
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) return null;
  return process.env[key] || null;
}

const defaultTransport: NotificationTransport = async ({ type, endpoint, displayName, payload }) => {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(type === "EMAIL" ? { channel: displayName, subject: payload.title, text: payload.body, metadata: payload } : payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${type} delivery failed with HTTP ${response.status}`);
};

export async function upsertNotificationRule(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = notificationRuleSchema.parse(raw);
  const rule = await db.notificationRule.upsert({
    where: { clientId_eventType_severity_channelType: { clientId: context.clientId, eventType: input.eventType, severity: input.severity, channelType: input.channelType } },
    update: { enabled: input.enabled, cooldownMinutes: input.cooldownMinutes },
    create: { clientId: context.clientId, ...input },
  });
  await db.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "NOTIFICATION_RULE_UPDATED", entityType: "NotificationRule", entityId: rule.id, metadata: input } });
  return rule;
}

export function listNotificationRules(context: RequestContext) {
  return db.notificationRule.findMany({ where: { clientId: context.clientId }, orderBy: [{ eventType: "asc" }, { severity: "asc" }, { channelType: "asc" }] });
}

export async function prepareNotificationEvent(
  tx: Prisma.TransactionClient,
  context: Pick<RequestContext, "clientId">,
  raw: NotificationEvent,
) {
  const input = notificationEventSchema.parse(raw);
  const severity = input.urgent ? NotificationSeverity.URGENT : NotificationSeverity.NORMAL;
  const dedupeKey = input.dedupeKey || (input.relatedType && input.relatedId ? `${input.eventType}:${input.relatedType}:${input.relatedId}` : null);
  const now = new Date();
  if (dedupeKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${context.clientId}), hashtext(${dedupeKey}))`;
  }
  const rules = await tx.notificationRule.findMany({
    where: { clientId: context.clientId, eventType: input.eventType, severity, enabled: true, channelType: { in: [...externalNotificationChannelTypes] } },
  });
  const externalTypes = [...new Set(rules.map((rule) => rule.channelType))];
  const existing = dedupeKey
    ? await tx.inAppNotification.findUnique({ where: { clientId_dedupeKey: { clientId: context.clientId, dedupeKey } } })
    : null;
  const notification = existing
    ? await tx.inAppNotification.update({ where: { id: existing.id }, data: { severity, title: input.title, body: input.body, relatedType: input.relatedType, relatedId: input.relatedId, eventType: input.eventType, occurrenceCount: { increment: 1 }, lastOccurredAt: now, readAt: null } })
    : await tx.inAppNotification.create({ data: { clientId: context.clientId, severity, title: input.title, body: input.body, relatedType: input.relatedType, relatedId: input.relatedId, eventType: input.eventType, dedupeKey, lastOccurredAt: now } });
  const channels = externalTypes.length
    ? await tx.notificationChannel.findMany({ where: { clientId: context.clientId, type: { in: externalTypes }, status: "VERIFIED" } })
    : [];
  const pendingDeliveries = [];
  for (const channel of channels) {
    const rule = rules.find((candidate) => candidate.channelType === channel.type);
    if (!rule) continue;
    const latest = await tx.notificationDelivery.findFirst({
      where: { notificationId: notification.id, channelId: channel.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (latest && now.getTime() - latest.createdAt.getTime() < rule.cooldownMinutes * 60_000) continue;
    const delivery = await tx.notificationDelivery.create({
      data: { clientId: context.clientId, notificationId: notification.id, channelId: channel.id },
    });
    pendingDeliveries.push({ delivery, channel });
  }
  return {
    notification,
    pendingDeliveries,
    selectedChannels: ["IN_APP", ...externalTypes],
    deduplicated: Boolean(existing) && pendingDeliveries.length === 0,
    payload: { title: input.title, body: input.body, eventType: input.eventType, relatedType: input.relatedType, relatedId: input.relatedId },
  };
}

export type PreparedNotificationEvent = Awaited<ReturnType<typeof prepareNotificationEvent>>;

export async function dispatchPreparedNotification(prepared: PreparedNotificationEvent, transport: NotificationTransport = defaultTransport) {
  const deliveries = [];
  for (const { delivery, channel } of prepared.pendingDeliveries) {
    const endpoint = resolveCredentialRef(channel.credentialRef);
    try {
      if (!endpoint) throw new Error("Channel endpoint credential is missing");
      await transport({ type: channel.type, endpoint, displayName: channel.displayName, payload: prepared.payload });
      deliveries.push(await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "DELIVERED", attemptCount: 1, deliveredAt: new Date(), lastError: null } }));
    } catch (error) {
      deliveries.push(await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", attemptCount: 1, lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown delivery failure" } }));
    }
  }
  return { notification: prepared.notification, deliveries, deduplicated: prepared.deduplicated, selectedChannels: prepared.selectedChannels };
}

export async function createAndDispatchNotification(context: Pick<RequestContext, "clientId">, raw: NotificationEvent, transport: NotificationTransport = defaultTransport) {
  const prepared = await db.$transaction((tx) => prepareNotificationEvent(tx, context, raw));
  return dispatchPreparedNotification(prepared, transport);
}

export async function listNotificationInbox(context: RequestContext, raw: unknown = {}) {
  const input = inboxFilterSchema.parse(raw);
  return db.inAppNotification.findMany({
    where: { clientId: context.clientId, ...(input.view === "unread" ? { readAt: null } : {}), ...(input.view === "important" ? { severity: NotificationSeverity.URGENT } : {}) },
    include: { deliveries: { include: { channel: { select: { id: true, type: true, displayName: true } } } } },
    orderBy: [{ lastOccurredAt: "desc" }, { id: "desc" }], take: input.limit,
  });
}

export async function setNotificationReadState(context: RequestContext, notificationId: string, read: boolean) {
  assertCanWrite(context);
  const notification = await db.inAppNotification.findFirst({ where: { id: notificationId, clientId: context.clientId }, select: { id: true } });
  if (!notification) throw new AppError("通知不存在或无权访问。", 404, "NOTIFICATION_NOT_FOUND");
  return db.inAppNotification.update({ where: { id: notification.id }, data: { readAt: read ? new Date() : null } });
}

export async function markAllNotificationsRead(context: RequestContext) {
  assertCanWrite(context);
  const readAt = new Date();
  const result = await db.inAppNotification.updateMany({ where: { clientId: context.clientId, readAt: null }, data: { readAt } });
  return { updated: result.count, readAt };
}

export const notificationSchemas = { event: notificationEventSchema, rule: notificationRuleSchema, inbox: inboxFilterSchema };
