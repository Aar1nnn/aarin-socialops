import { NextResponse } from "next/server";
import { requireContext } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { completePlatformConnection } from "@/services/platform-connection-service";

export async function GET(request: Request) {
  try {
    const context = await requireContext();
    const url = new URL(request.url);
    const providerError = url.searchParams.get("error");
    if (providerError) throw new AppError("Meta 授权未完成，请重新连接。", 400, "META_AUTHORIZATION_DECLINED");
    const result = await completePlatformConnection(context, "META", {
      code: url.searchParams.get("code") || "",
      state: url.searchParams.get("state") || "",
    });
    return NextResponse.redirect(new URL(result.returnTo, request.url), 303);
  } catch (error) {
    return errorResponse(error);
  }
}
