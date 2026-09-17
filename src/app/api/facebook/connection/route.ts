import { requireContext } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { configureFacebookPage } from "@/services/facebook-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    if (context.role !== "OWNER") throw new AppError("只有客户负责人可修改 Facebook 凭据引用。", 403, "FORBIDDEN");
    const body = await requestData(request);
    const result = await configureFacebookPage(context, {
      accountId: String(body.accountId || ""),
      pageId: String(body.pageId || ""),
      graphApiVersion: String(body.graphApiVersion || "v26.0"),
      credentialRef: String(body.credentialRef || ""),
      requiredPermissions: String(body.requiredPermissions || "").split(",").map((value) => value.trim()).filter(Boolean),
      metricKeys: String(body.metricKeys || "").split(",").map((value) => value.trim()).filter(Boolean),
    });
    return actionResponse(request, result, "/settings");
  } catch (error) {
    return errorResponse(error);
  }
}
