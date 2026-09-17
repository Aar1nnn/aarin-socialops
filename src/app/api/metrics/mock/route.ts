import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { createMockMetricSnapshots } from "@/services/report-service";

export async function POST(request: Request) {
  try {
    return actionResponse(request, await createMockMetricSnapshots(await requireContext()), "/insights");
  } catch (error) {
    return errorResponse(error);
  }
}
