import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { getQueueOccurrences, upsertScheduleQueue } from "@/services/schedule-queue-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const after = new URL(request.url).searchParams.get("after");
    return Response.json(await getQueueOccurrences(context, id, after ? new Date(after) : new Date()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return Response.json(await upsertScheduleQueue(context, id, await requestData(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
