import { requireContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { zonedLocalDateTimeToUtc } from "@/lib/timezone";
import { bulkRescheduleCalendarItems, rescheduleCalendarItem } from "@/services/calendar-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    if (Array.isArray(body.changes)) {
      const result = await bulkRescheduleCalendarItems(context, { changes: body.changes });
      return actionResponse(request, result, "/calendar?view=list");
    }
    const client = await db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } });
    const timezone = String(body.timezone || client.timezone);
    if (timezone !== client.timezone) throw new AppError("排期时区与客户配置不一致，请刷新页面。", 409, "SCHEDULE_TIMEZONE_MISMATCH");
    const scheduledAt = zonedLocalDateTimeToUtc(String(body.scheduledAt), client.timezone);
    const result = await rescheduleCalendarItem(context, String(body.contentItemId), scheduledAt);
    return actionResponse(request, result, "/calendar?view=list");
  } catch (error) {
    return errorResponse(error);
  }
}
