import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { recordManualPublishResult } from "@/services/manual-publish-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const result = await recordManualPublishResult(context, id, await requestData(request));
    return actionResponse(request, result, "/publishing");
  } catch (error) {
    return errorResponse(error);
  }
}
