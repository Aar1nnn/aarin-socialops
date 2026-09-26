import type { Prisma } from "@prisma/client";
import { OPEN_MANUAL_TASK_STATUSES } from "../lib/publishing-status";

export async function cancelManualTasksForVersion(tx: Prisma.TransactionClient, clientId: string, contentVersionId: string) {
  return tx.manualTask.updateMany({
    where: {
      clientId,
      status: { in: [...OPEN_MANUAL_TASK_STATUSES] },
      publishJob: { contentVersionId, adapter: "manual", status: "CANCELLED" },
    },
    data: { status: "CANCELLED", completedAt: null },
  });
}

export async function cancelManualTasksForProduct(tx: Prisma.TransactionClient, clientId: string, productId: string) {
  return tx.manualTask.updateMany({
    where: {
      clientId,
      status: { in: [...OPEN_MANUAL_TASK_STATUSES] },
      publishJob: { adapter: "manual", status: "CANCELLED", contentVersion: { item: { plan: { productId } } } },
    },
    data: { status: "CANCELLED", completedAt: null },
  });
}
