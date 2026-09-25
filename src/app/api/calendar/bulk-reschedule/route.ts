import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { bulkRescheduleWithResults } from "@/services/schedule-queue-service";

export async function POST(request: Request) {
  try {
    return Response.json(await bulkRescheduleWithResults(await requireContext(), await requestData(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
