import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { detectScheduleConflict } from "@/services/schedule-queue-service";

export async function POST(request: Request) {
  try {
    return Response.json(await detectScheduleConflict(await requireContext(), await requestData(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
