import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getAnalyticsDataHealth } from "@/services/analytics-service";

export async function GET() {
  try { return Response.json(await getAnalyticsDataHealth(await requireContext())); }
  catch (error) { return errorResponse(error); }
}
