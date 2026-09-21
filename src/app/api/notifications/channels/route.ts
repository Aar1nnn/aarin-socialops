import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { upsertNotificationChannel } from "@/services/notification-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const channel = await upsertNotificationChannel(context, {
      type: body.type,
      displayName: body.displayName,
      endpoint: body.endpoint,
      recipient: body.recipient || undefined,
      credentialRef: body.credentialRef || undefined,
    });
    return actionResponse(request, channel, "/notifications");
  } catch (error) {
    return errorResponse(error);
  }
}
