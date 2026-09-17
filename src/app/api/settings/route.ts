import { ClientMode } from "@prisma/client";
import { requireContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    if (context.role !== "OWNER") throw new AppError("只有客户负责人可修改设置。", 403, "FORBIDDEN");
    const body = await requestData(request);
    const mode = String(body.mode || "");
    if (!Object.values(ClientMode).includes(mode as ClientMode)) {
      throw new AppError("运行模式无效。", 400, "INVALID_MODE");
    }
    const targetMarkets = String(body.targetMarkets || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const usageMonthlyLimit = Number(body.usageMonthlyLimit || 100000);
    if (!Number.isSafeInteger(usageMonthlyLimit) || usageMonthlyLimit < 0) throw new AppError("使用量上限必须是非负整数。", 400, "INVALID_USAGE_LIMIT");
    const textProvider = String(body.textProvider || "unconfigured");
    if (!["unconfigured", "mock", "openai-compatible"].includes(textProvider)) throw new AppError("文本生成 Provider 无效。", 400, "INVALID_TEXT_PROVIDER");
    const confirmTextModelVerified = String(body.confirmTextModelVerified || "") === "true";
    if (textProvider === "openai-compatible" && confirmTextModelVerified && !(process.env.TEXT_MODEL_BASE_URL && process.env.TEXT_MODEL_API_KEY && process.env.TEXT_MODEL_NAME)) {
      throw new AppError("真实模型环境变量不完整，不能标记为已验证。", 409, "MODEL_CREDENTIALS_MISSING");
    }
    const current = await db.client.findUniqueOrThrow({ where: { id: context.clientId } });
    const currentContact = (current.contactDetails || {}) as Record<string, unknown>;
    const client = await db.$transaction(async (tx) => {
      const updated = await tx.client.update({ where: { id: context.clientId }, data: {
        mode: mode as ClientMode,
        timezone: String(body.timezone || "Asia/Shanghai"),
        targetMarkets,
        productFocus: String(body.productFocus || "") || null,
        brandGuidelines: String(body.brandGuidelines || "") || null,
        contactDetails: {
          ...currentContact,
          website: String(body.website || "") || null,
          whatsapp: String(body.whatsapp || "") || null,
          notificationContact: String(body.notificationContact || "") || null,
        },
        usageMonthlyLimit,
      } });
      await tx.integrationConfig.updateMany({ where: { clientId: context.clientId, type: "TEXT_GENERATION" }, data: { status: "UNVERIFIED", verifiedAt: null } });
      const integrationStatus = textProvider === "mock" || (textProvider === "openai-compatible" && confirmTextModelVerified) ? "VERIFIED" : textProvider === "unconfigured" ? "UNCONFIGURED" : "UNVERIFIED";
      await tx.integrationConfig.upsert({
        where: { clientId_type_provider: { clientId: context.clientId, type: "TEXT_GENERATION", provider: textProvider } },
        update: { status: integrationStatus, verifiedAt: integrationStatus === "VERIFIED" ? new Date() : null, credentialRef: textProvider === "openai-compatible" ? "env:TEXT_MODEL_API_KEY" : null, publicConfig: { configuredBy: "operator", secretStored: false } },
        create: { clientId: context.clientId, type: "TEXT_GENERATION", provider: textProvider, status: integrationStatus, verifiedAt: integrationStatus === "VERIFIED" ? new Date() : null, credentialRef: textProvider === "openai-compatible" ? "env:TEXT_MODEL_API_KEY" : null, publicConfig: { configuredBy: "operator", secretStored: false } },
      });
      await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "CLIENT_SETTINGS_UPDATED", entityType: "Client", entityId: context.clientId, metadata: { previousMode: current.mode, mode, targetMarketCount: targetMarkets.length, usageMonthlyLimit } } });
      return updated;
    });
    return actionResponse(request, client, "/settings");
  } catch (error) {
    return errorResponse(error);
  }
}
