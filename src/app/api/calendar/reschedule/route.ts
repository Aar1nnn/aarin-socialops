import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { rescheduleCalendarItems } from "@/services/calendar-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const ids = Array.isArray(body.contentItemIds)
      ? body.contentItemIds.map(String)
      : String(body.contentItemIds || body.contentItemId || "").split(",").filter(Boolean);
    const result = await rescheduleCalendarItems(context, { contentItemIds: ids, scheduledAt: body.scheduledAt });
    return actionResponse(request, result, "/calendar");
  } catch (error) {
    return errorResponse(error);
  }
}
