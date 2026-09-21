import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { verifyNotificationChannel } from "@/services/notification-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const channel = await verifyNotificationChannel(context, id);
    return actionResponse(request, channel, "/notifications");
  } catch (error) {
    return errorResponse(error);
  }
}
