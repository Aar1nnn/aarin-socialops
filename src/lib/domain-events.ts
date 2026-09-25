import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { RequestContext } from "./context";
import { db } from "./db";

export const domainEventTypes = [
  "CONTENT_CREATED",
  "CONTENT_VERSION_CREATED",
  "REVIEW_REQUESTED",
  "CHANGES_REQUESTED",
  "CONTENT_APPROVED",
  "CONTENT_SCHEDULED",
  "PUBLISH_FAILED",
  "PUBLISH_UNKNOWN",
  "CONNECTION_ERROR",
  "URGENT_LEAD",
] as const;

const domainEventSchema = z.object({
  type: z.enum(domainEventTypes),
  entityType: z.string().trim().min(1).max(100),
  entityId: z.string().max(200).nullable().optional(),
  metadata: z.custom<Prisma.InputJsonValue>().optional(),
});

type AuditWriter = Pick<Prisma.TransactionClient, "auditLog">;

export async function recordDomainEvent(
  context: Pick<RequestContext, "clientId"> & Partial<Pick<RequestContext, "userId">>,
  raw: z.input<typeof domainEventSchema>,
  writer: AuditWriter = db,
) {
  const event = domainEventSchema.parse(raw);
  return writer.auditLog.create({
    data: {
      clientId: context.clientId,
      userId: context.userId ?? null,
      action: event.type,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
    },
  });
}

export const domainEventContract = domainEventSchema;
