import { z } from "zod";
import { db } from "../lib/db";
import type { RequestContext } from "../lib/context";

const notificationEventSchema = z.object({
  eventType: z.enum(["URGENT_LEAD", "PUBLISH_FAILED", "PUBLISH_UNKNOWN", "TOKEN_EXPIRED", "PERMISSION_MISSING", "PLATFORM_DISCONNECTED", "HIGH_PRIORITY_TASK"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  relatedType: z.string().max(100).optional(),
  relatedId: z.string().max(200).optional(),
  urgent: z.boolean().default(false),
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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(type === "EMAIL" ? { channel: displayName, subject: payload.title, text: payload.body, metadata: payload } : payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${type} delivery failed with HTTP ${response.status}`);
};

export async function createAndDispatchNotification(context: RequestContext, raw: NotificationEvent, transport: NotificationTransport = defaultTransport) {
  const input = notificationEventSchema.parse(raw);
  const notification = await db.inAppNotification.create({
    data: {
      clientId: context.clientId,
      severity: input.urgent ? "URGENT" : "NORMAL",
      title: input.title,
      body: input.body,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
    },
  });
  const channels = await db.notificationChannel.findMany({
    where: { clientId: context.clientId, type: { in: ["WEBHOOK", "EMAIL"] }, status: "VERIFIED" },
  });
  const deliveries = [];
  for (const channel of channels) {
    const delivery = await db.notificationDelivery.create({
      data: { clientId: context.clientId, notificationId: notification.id, channelId: channel.id },
    });
    const endpoint = resolveCredentialRef(channel.credentialRef);
    try {
      if (!endpoint) throw new Error("Channel endpoint credential is missing");
      await transport({
        type: channel.type,
        endpoint,
        displayName: channel.displayName,
        payload: { title: input.title, body: input.body, eventType: input.eventType, relatedType: input.relatedType, relatedId: input.relatedId },
      });
      deliveries.push(await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "DELIVERED", attemptCount: 1, deliveredAt: new Date() } }));
    } catch (error) {
      deliveries.push(await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", attemptCount: 1, lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown delivery failure" } }));
    }
  }
  return { notification, deliveries };
}
