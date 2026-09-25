import { randomUUID } from "node:crypto";
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
const defaultDeliveryLeaseSeconds = 60;

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
export type ExternalNotificationPayload = {
  title: string;
  body: string;
  eventType: string;
  relatedType?: string;
  relatedId?: string;
  dedupeKey?: string;
};
export type NotificationTransport = (input: {
  type: string;
  endpoint: string;
  displayName: string;
  deliveryId: string;
  notificationId: string;
  payload: ExternalNotificationPayload;
}) => Promise<void>;

function resolveCredentialRef(ref: string | null) {
  if (!ref?.startsWith("env:")) return null;
  const key = ref.slice(4);
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) return null;
  return process.env[key] || null;
}

function requireHttpsEndpoint(endpoint: string | null) {
  if (!endpoint) throw new Error("Channel endpoint credential is missing");
  try {
    if (new URL(endpoint).protocol === "https:") return endpoint;
  } catch {
    // Invalid URLs are handled by the same delivery failure path.
  }
  throw new Error("Channel endpoint must be an HTTPS URL");
}

const defaultTransport: NotificationTransport = async ({ type, endpoint, displayName, deliveryId, notificationId, payload }) => {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", "x-aarin-delivery-id": deliveryId },
    body: JSON.stringify(type === "EMAIL"
      ? { channel: displayName, subject: payload.title, text: payload.body, metadata: { ...payload, deliveryId, notificationId } }
      : { ...payload, deliveryId, notificationId }),
    redirect: "error",
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
  for (const { delivery } of prepared.pendingDeliveries) {
    const claimed = await claimNotificationDelivery(delivery.id, defaultDeliveryLeaseSeconds);
    const dispatched = claimed
      ? await dispatchClaimedNotificationDelivery(claimed, transport)
      : await db.notificationDelivery.findUnique({ where: { id: delivery.id } });
    if (dispatched) deliveries.push(dispatched);
  }
  return { notification: prepared.notification, deliveries, deduplicated: prepared.deduplicated, selectedChannels: prepared.selectedChannels };
}

export async function dispatchPendingNotificationDeliveries(
  limit = 20,
  transport: NotificationTransport = defaultTransport,
  leaseSeconds = defaultDeliveryLeaseSeconds,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new AppError("通知投递批次大小无效。", 400, "INVALID_NOTIFICATION_BATCH_SIZE");
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 15 * 60) {
    throw new AppError("通知投递租约时长无效。", 400, "INVALID_NOTIFICATION_LEASE_SECONDS");
  }
  const deliveries = [];
  for (let index = 0; index < limit; index += 1) {
    const claimed = await claimNextNotificationDelivery(leaseSeconds);
    if (!claimed) break;
    const delivery = await dispatchClaimedNotificationDelivery(claimed, transport);
    if (delivery) deliveries.push(delivery);
  }
  return deliveries;
}

type ClaimedNotificationDelivery = { id: string; leaseToken: string };

function deliveryLease(leaseSeconds: number) {
  const lockedAt = new Date();
  return {
    lockedAt,
    staleBefore: new Date(lockedAt.getTime() - leaseSeconds * 1000),
    leaseToken: `notification-delivery:${randomUUID()}`,
  };
}

async function claimNotificationDelivery(deliveryId: string, leaseSeconds: number): Promise<ClaimedNotificationDelivery | null> {
  const lease = deliveryLease(leaseSeconds);
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "NotificationDelivery"
    SET
      "lockedAt" = ${lease.lockedAt},
      "lockedBy" = ${lease.leaseToken},
      "attemptCount" = "attemptCount" + 1,
      "updatedAt" = ${lease.lockedAt}
    WHERE
      "id" = ${deliveryId}
      AND "status" = 'PENDING'::"NotificationDeliveryStatus"
      AND ("lockedAt" IS NULL OR "lockedAt" < ${lease.staleBefore})
    RETURNING "id"
  `;
  return claimed[0] ? { id: claimed[0].id, leaseToken: lease.leaseToken } : null;
}

async function claimNextNotificationDelivery(leaseSeconds: number): Promise<ClaimedNotificationDelivery | null> {
  const lease = deliveryLease(leaseSeconds);
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    WITH candidate AS (
      SELECT "id"
      FROM "NotificationDelivery"
      WHERE
        "status" = 'PENDING'::"NotificationDeliveryStatus"
        AND ("lockedAt" IS NULL OR "lockedAt" < ${lease.staleBefore})
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "NotificationDelivery" AS delivery
    SET
      "lockedAt" = ${lease.lockedAt},
      "lockedBy" = ${lease.leaseToken},
      "attemptCount" = delivery."attemptCount" + 1,
      "updatedAt" = ${lease.lockedAt}
    FROM candidate
    WHERE delivery."id" = candidate."id"
    RETURNING delivery."id"
  `;
  return claimed[0] ? { id: claimed[0].id, leaseToken: lease.leaseToken } : null;
}

async function dispatchClaimedNotificationDelivery(
  claimed: ClaimedNotificationDelivery,
  transport: NotificationTransport,
) {
  const delivery = await db.notificationDelivery.findUnique({
    where: { id: claimed.id },
    include: { channel: true, notification: true },
  });
  if (!delivery || delivery.status !== "PENDING" || delivery.lockedBy !== claimed.leaseToken) return delivery;
  const payload: ExternalNotificationPayload = {
    title: delivery.notification.title,
    body: delivery.notification.body,
    eventType: delivery.notification.eventType,
    relatedType: delivery.notification.relatedType ?? undefined,
    relatedId: delivery.notification.relatedId ?? undefined,
    dedupeKey: delivery.notification.dedupeKey ?? undefined,
  };
  try {
    const endpoint = requireHttpsEndpoint(resolveCredentialRef(delivery.channel.credentialRef));
    await transport({
      type: delivery.channel.type,
      endpoint,
      displayName: delivery.channel.displayName,
      deliveryId: delivery.id,
      notificationId: delivery.notificationId,
      payload,
    });
    await db.notificationDelivery.updateMany({
      where: { id: delivery.id, status: "PENDING", lockedBy: claimed.leaseToken },
      data: { status: "DELIVERED", deliveredAt: new Date(), lastError: null, lockedAt: null, lockedBy: null },
    });
  } catch (error) {
    await db.notificationDelivery.updateMany({
      where: { id: delivery.id, status: "PENDING", lockedBy: claimed.leaseToken },
      data: {
        status: "FAILED",
        lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown delivery failure",
        lockedAt: null,
        lockedBy: null,
      },
    });
  }
  return db.notificationDelivery.findUnique({ where: { id: delivery.id } });
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
