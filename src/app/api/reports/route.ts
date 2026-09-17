import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { generateOperationReport } from "@/services/report-service";

export async function POST(request: Request) {
  try {
    return actionResponse(request, await generateOperationReport(await requireContext()), "/insights");
  } catch (error) {
    return errorResponse(error);
  }
}
