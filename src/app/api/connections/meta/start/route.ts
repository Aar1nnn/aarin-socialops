import { NextResponse } from "next/server";
import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { startPlatformConnection } from "@/services/platform-connection-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const result = await startPlatformConnection(context, "META", String(body.returnTo || "/connections"));
    return NextResponse.redirect(result.authorizationUrl, 303);
  } catch (error) {
    return errorResponse(error);
  }
}
