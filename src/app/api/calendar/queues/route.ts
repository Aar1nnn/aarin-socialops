import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { listScheduleQueues, upsertScheduleQueue } from "@/services/schedule-queue-service";

export async function GET() {
  try {
    return Response.json(await listScheduleQueues(await requireContext()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    return Response.json(await upsertScheduleQueue(context, null, body));
  } catch (error) {
    return errorResponse(error);
  }
}
