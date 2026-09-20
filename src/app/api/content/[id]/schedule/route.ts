import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { schedulePublication } from "@/services/content-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    const result = await schedulePublication(context, id, body.scheduledAt
      ? new Date(String(body.scheduledAt))
      : {
          publishMode: String(body.publishMode || "NOW") === "SCHEDULED" ? "SCHEDULED" : "NOW",
          localDateTime: body.localDateTime ? String(body.localDateTime) : undefined,
          timezone: body.timezone ? String(body.timezone) : undefined,
        });
    return actionResponse(request, result, "/content");
  } catch (error) {
    return errorResponse(error);
  }
}
