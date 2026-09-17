import { randomUUID } from "node:crypto";
import { UsageReservationStatus } from "@prisma/client";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

function monthStartUtc(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function reserveUsage(input: {
  clientId: string;
  capability: string;
  provider: string;
  units: number;
  ttlMs?: number;
}) {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) throw new AppError("用量预占单位无效。", 400, "INVALID_USAGE_RESERVATION");
  const now = new Date();
  const requestKey = randomUUID();
  const reservation = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${input.clientId} FOR UPDATE`;
    const client = await tx.client.findUnique({ where: { id: input.clientId } });
    if (!client) throw new AppError("客户不存在。", 404, "CLIENT_NOT_FOUND");
    await tx.usageReservation.updateMany({ where: { clientId: input.clientId, status: UsageReservationStatus.RESERVED, expiresAt: { lte: now } }, data: { status: UsageReservationStatus.EXPIRED } });
    const [used, active] = await Promise.all([
      tx.usageLog.aggregate({ where: { clientId: input.clientId, createdAt: { gte: monthStartUtc(now) }, simulated: false }, _sum: { inputUnits: true, outputUnits: true } }),
      tx.usageReservation.aggregate({ where: { clientId: input.clientId, status: UsageReservationStatus.RESERVED, expiresAt: { gt: now }, createdAt: { gte: monthStartUtc(now) } }, _sum: { reservedUnits: true } }),
    ]);
    const usedUnits = (used._sum.inputUnits || 0) + (used._sum.outputUnits || 0);
    const reservedUnits = active._sum.reservedUnits || 0;
    if (usedUnits + reservedUnits + input.units > client.usageMonthlyLimit) {
      const existing = await tx.manualTask.findFirst({ where: { clientId: input.clientId, triggerReason: "文本模型月度使用量上限已触达", status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } } });
      if (!existing) await tx.manualTask.create({ data: { clientId: input.clientId, triggerReason: "文本模型月度使用量上限已触达", priority: "HIGH", sourceMaterial: { usedUnits, reservedUnits, requestedUnits: input.units }, requiredAction: "检查本月已结算和预占用量，并由运营者决定是否调整客户上限。", completionCriteria: "预算上限或调用计划已经人工确认。", continuationStep: "重新发起内容生成请求。" } });
      return null;
    }
    return tx.usageReservation.create({ data: { clientId: input.clientId, requestKey, capability: input.capability, provider: input.provider, reservedUnits: input.units, expiresAt: new Date(now.getTime() + (input.ttlMs || 5 * 60_000)) } });
  });
  if (!reservation) throw new AppError("本次真实模型调用会超过客户月度使用量上限。", 429, "USAGE_LIMIT_EXCEEDED");
  return reservation;
}

export async function settleUsage(input: {
  reservationId: string;
  clientId: string;
  model: string | null;
  inputUnits: number;
  outputUnits: number;
}) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "UsageReservation" WHERE "id" = ${input.reservationId} AND "clientId" = ${input.clientId} FOR UPDATE`;
    const reservation = await tx.usageReservation.findFirst({ where: { id: input.reservationId, clientId: input.clientId } });
    if (!reservation) throw new AppError("用量预占不存在。", 404, "USAGE_RESERVATION_NOT_FOUND");
    if (reservation.status === UsageReservationStatus.SETTLED) return reservation;
    if (reservation.status !== UsageReservationStatus.RESERVED) throw new AppError("用量预占已释放或过期。", 409, "USAGE_RESERVATION_INACTIVE");
    const settledUnits = Math.max(0, input.inputUnits) + Math.max(0, input.outputUnits);
    await tx.usageLog.create({ data: { clientId: input.clientId, capability: reservation.capability, provider: reservation.provider, model: input.model, inputUnits: Math.max(0, input.inputUnits), outputUnits: Math.max(0, input.outputUnits), simulated: false } });
    return tx.usageReservation.update({ where: { id: reservation.id }, data: { status: UsageReservationStatus.SETTLED, settledUnits } });
  });
}

export async function releaseUsage(reservationId: string, clientId: string) {
  return db.usageReservation.updateMany({ where: { id: reservationId, clientId, status: UsageReservationStatus.RESERVED }, data: { status: UsageReservationStatus.RELEASED, settledUnits: 0 } });
}
