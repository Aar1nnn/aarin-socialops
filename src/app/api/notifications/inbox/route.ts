import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { listNotificationInbox, markAllNotificationsRead } from "@/services/notification-service";

export async function GET(request: Request) {
  try { return Response.json(await listNotificationInbox(await requireContext(), Object.fromEntries(new URL(request.url).searchParams.entries()))); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await requestData(request);
    if (body.operation !== "mark_all_read") return Response.json({ error: "INVALID_INBOX_OPERATION", message: "Unsupported inbox operation." }, { status: 400 });
    return Response.json(await markAllNotificationsRead(await requireContext()));
  } catch (error) { return errorResponse(error); }
}
