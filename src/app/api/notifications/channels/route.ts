import { requireContext } from "@/lib/auth";
import { assertOwner } from "@/lib/context";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    assertOwner(context);
    const body = await requestData(request);
    const type = String(body.type || "").toUpperCase();
    if (!['WEBHOOK', 'EMAIL'].includes(type)) throw new AppError("通知通道类型无效。", 400, "INVALID_NOTIFICATION_CHANNEL");
    const displayName = String(body.displayName || "").trim();
    const credentialRef = String(body.credentialRef || "").trim();
    if (!displayName) throw new AppError("通知通道名称不能为空。", 400, "CHANNEL_NAME_REQUIRED");
    if (!/^env:[A-Z][A-Z0-9_]+$/.test(credentialRef)) throw new AppError("凭据必须使用 env:VARIABLE_NAME 引用。", 400, "INVALID_CREDENTIAL_REF");
    const environmentKey = credentialRef.slice(4);
    const endpoint = process.env[environmentKey];
    const confirmed = String(body.confirmVerified || "") === "true";
    if (confirmed && !endpoint) throw new AppError("服务器环境变量尚未配置，不能标记为已验证。", 409, "CHANNEL_CREDENTIAL_MISSING");
    if (endpoint) {
      try { new URL(endpoint); } catch { throw new AppError("通知端点环境变量不是有效 URL。", 409, "CHANNEL_ENDPOINT_INVALID"); }
    }
    const channel = await db.notificationChannel.upsert({
      where: { clientId_type_displayName: { clientId: context.clientId, type, displayName } },
      update: { credentialRef, status: confirmed ? "VERIFIED" : "UNVERIFIED", verifiedAt: confirmed ? new Date() : null },
      create: { clientId: context.clientId, type, displayName, credentialRef, status: confirmed ? "VERIFIED" : "UNVERIFIED", verifiedAt: confirmed ? new Date() : null },
    });
    await db.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "NOTIFICATION_CHANNEL_CONFIGURED", entityType: "NotificationChannel", entityId: channel.id, metadata: { type, credentialConfigured: true, verified: confirmed } } });
    return actionResponse(request, channel, "/settings");
  } catch (error) {
    return errorResponse(error);
  }
}
