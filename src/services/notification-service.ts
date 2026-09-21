import { CapabilityStatus, NotificationSeverity, type InAppNotification, type NotificationChannel } from "@prisma/client";
import { z } from "zod";
import { isIP } from "node:net";
import { assertOwner, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { resolveServerSecret } from "../lib/secrets";

export const notificationEventTypes = [
  "URGENT_LEAD",
  "PUBLISH_FAILED",
  "PUBLISH_UNKNOWN",
  "TOKEN_EXPIRED",
  "PERMISSION_MISSING",
  "PLATFORM_DISCONNECTED",
  "HIGH_PRIORITY_TASK",
] as const;

export const notificationEventSchema = z.object({
  type: z.enum(notificationEventTypes),
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(4000),
  relatedType: z.string().trim().max(100).optional(),
  relatedId: z.string().trim().max(200).optional(),
});

export const notificationChannelSchema = z.object({
  type: z.enum(["WEBHOOK", "EMAIL"]),
  displayName: z.string().trim().min(1).max(120),
  endpoint: z.string().url(),
  recipient: z.string().email().optional(),
  credentialRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "EMAIL" && !value.recipient) ctx.addIssue({ code: "custom", path: ["recipient"], message: "Email channel requires a recipient." });
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    return;
  }
  const hostname = endpoint.hostname.toLocaleLowerCase();
  const privateIpv4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  if (endpoint.protocol !== "https:") ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Notification endpoints must use HTTPS." });
  if (endpoint.username || endpoint.password || endpoint.search) ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Put credentials in credentialRef, not in the endpoint URL." });
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "::1" || hostname === "[::1]" || (isIP(hostname) === 4 && privateIpv4.test(hostname))) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Private and loopback notification endpoints are not allowed." });
  }
});

export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export interface NotificationDispatcher {
  send(channel: NotificationChannel, notification: InAppNotification): Promise<void>;
}

export class HttpNotificationDispatcher implements NotificationDispatcher {
  async send(channel: NotificationChannel, notification: InAppNotification) {
    const config = (channel.publicConfig || {}) as { endpoint?: string; recipient?: string };
    if (!config.endpoint) throw new AppError("Notification endpoint is missing.", 409, "NOTIFICATION_ENDPOINT_MISSING");
    const secret = channel.credentialRef ? resolveServerSecret(channel.credentialRef) : null;
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(channel.type === "EMAIL" ? {
        to: config.recipient,
        subject: notification.title,
        text: notification.body,
        event: { relatedType: notification.relatedType, relatedId: notification.relatedId },
      } : {
        id: notification.id,
        severity: notification.severity,
        title: notification.title,
        body: notification.body,
        relatedType: notification.relatedType,
        relatedId: notification.relatedId,
        createdAt: notification.createdAt,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Notification gateway returned HTTP ${response.status}`);
  }
}

export async function upsertNotificationChannel(context: RequestContext, raw: unknown) {
  assertOwner(context);
  const input = notificationChannelSchema.parse(raw);
  return db.notificationChannel.upsert({
    where: { clientId_type_displayName: { clientId: context.clientId, type: input.type, displayName: input.displayName } },
    update: {
      credentialRef: input.credentialRef ?? null,
      publicConfig: { endpoint: input.endpoint, recipient: input.recipient ?? null },
      status: CapabilityStatus.UNVERIFIED,
      lastError: null,
    },
    create: {
      clientId: context.clientId,
      type: input.type,
      displayName: input.displayName,
      credentialRef: input.credentialRef,
      publicConfig: { endpoint: input.endpoint, recipient: input.recipient ?? null },
      status: CapabilityStatus.UNVERIFIED,
    },
  });
}

export async function verifyNotificationChannel(context: RequestContext, channelId: string, dispatcher: NotificationDispatcher = new HttpNotificationDispatcher()) {
  assertOwner(context);
  const channel = await db.notificationChannel.findFirst({ where: { id: channelId, clientId: context.clientId } });
  if (!channel) throw new AppError("Notification channel not found.", 404, "NOTIFICATION_CHANNEL_NOT_FOUND");
  const probe = await db.inAppNotification.create({
    data: { clientId: context.clientId, severity: "NORMAL", title: `Test: ${channel.displayName}`, body: "Aarin SocialOps notification channel verification." },
  });
  try {
    await dispatcher.send(channel, probe);
    return db.notificationChannel.update({ where: { id: channel.id }, data: { status: CapabilityStatus.VERIFIED, verifiedAt: new Date(), lastDispatchAt: new Date(), lastError: null } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Notification verification failed";
    await db.notificationChannel.update({ where: { id: channel.id }, data: { status: CapabilityStatus.UNVERIFIED, lastError: message } });
    throw new AppError("Notification channel verification failed.", 502, "NOTIFICATION_VERIFICATION_FAILED");
  }
}

export async function createOperationalNotification(
  clientId: string,
  raw: unknown,
  dispatcher: NotificationDispatcher = new HttpNotificationDispatcher(),
) {
  const event = notificationEventSchema.parse(raw);
  const severity = event.type === "URGENT_LEAD" || event.type === "PUBLISH_FAILED" || event.type === "PUBLISH_UNKNOWN"
    ? NotificationSeverity.URGENT
    : NotificationSeverity.NORMAL;
  const notification = await db.inAppNotification.create({
    data: {
      clientId,
      severity,
      title: event.title,
      body: event.body,
      relatedType: event.relatedType || event.type,
      relatedId: event.relatedId,
    },
  });

  const deliveries = await dispatchNotificationBestEffort(clientId, notification, dispatcher);
  return { notification, deliveries };
}

export async function dispatchNotificationBestEffort(
  clientId: string,
  notification: InAppNotification,
  dispatcher: NotificationDispatcher = new HttpNotificationDispatcher(),
) {
  if (notification.clientId !== clientId) throw new AppError("Notification tenant mismatch.", 403, "NOTIFICATION_SCOPE_VIOLATION");
  const channels = await db.notificationChannel.findMany({
    where: { clientId, type: { in: ["WEBHOOK", "EMAIL"] }, status: CapabilityStatus.VERIFIED },
  });
  return Promise.all(channels.map(async (channel) => {
    try {
      await dispatcher.send(channel, notification);
      await db.notificationChannel.update({ where: { id: channel.id }, data: { lastDispatchAt: new Date(), lastError: null } });
      return { channelId: channel.id, delivered: true as const, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Notification delivery failed";
      try {
        await db.notificationChannel.update({ where: { id: channel.id }, data: { lastDispatchAt: new Date(), lastError: message } });
      } catch {
        // Delivery bookkeeping is deliberately isolated from the persisted business event.
      }
      return { channelId: channel.id, delivered: false as const, error: message };
    }
  }));
}
