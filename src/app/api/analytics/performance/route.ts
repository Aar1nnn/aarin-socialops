import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { getContentPerformance } from "@/services/analytics-service";

export async function POST(request: Request) {
  try { return Response.json(await getContentPerformance(await requireContext(), await requestData(request))); }
  catch (error) { return errorResponse(error); }
}
