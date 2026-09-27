import { requireContext } from "@/lib/auth";
import { assertOwner } from "@/lib/context";
import { AppError, errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { disconnectPlatformConnection } from "@/services/platform-connection-service";

export async function assertDisconnectConfirmation(request: Request) {
  const body = await requestData(request);
  if (body.confirmDisconnect !== "yes" && body.confirmDisconnect !== true) {
    throw new AppError("请先明确确认断开授权并清除本地凭据。", 400, "DISCONNECT_CONFIRMATION_REQUIRED");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    assertOwner(context);
    await assertDisconnectConfirmation(request);
    const { id } = await params;
    return actionResponse(request, await disconnectPlatformConnection(context, id), "/connections");
  } catch (error) {
    return errorResponse(error);
  }
}
