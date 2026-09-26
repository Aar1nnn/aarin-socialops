import { requireContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { assertCanWrite } from "@/lib/context";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    assertCanWrite(context);
    const { id } = await params;
    const body = await requestData(request);
    const status = String(body.status || "");
    if (!["TODO", "IN_PROGRESS", "WAITING_EXTERNAL", "COMPLETED", "CANCELLED"].includes(status)) {
      throw new AppError("人工任务状态无效。", 400, "INVALID_TASK_STATUS");
    }
    const task = await db.manualTask.findFirst({ where: { id, clientId: context.clientId } });
    if (!task) throw new AppError("任务不存在或无权访问。", 404, "TASK_NOT_FOUND");
    if (task.publishJobId) {
      const job = await db.publishJob.findFirst({ where: { id: task.publishJobId, clientId: context.clientId }, select: { adapter: true } });
      if (job?.adapter === "manual") throw new AppError("人工发布任务必须在发布中心记录结果与证据。", 409, "MANUAL_PUBLISH_RESULT_REQUIRED");
    }
    const result = await db.$transaction(async (tx) => {
      const updated = await tx.manualTask.update({ where: { id: task.id }, data: {
        status: status as typeof task.status,
        completedAt: status === "COMPLETED" ? new Date() : null,
      } });
      await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "MANUAL_TASK_STATUS_UPDATED", entityType: "ManualTask", entityId: task.id, metadata: { previousStatus: task.status, status } } });
      return updated;
    });
    return actionResponse(request, result, "/");
  } catch (error) {
    return errorResponse(error);
  }
}
