import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { runAiContentPipeline } from "@/services/ai-content-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    const result = await runAiContentPipeline(context, id, { intent: body.intent });
    return actionResponse(request, result, "/calendar?view=list");
  } catch (error) {
    return errorResponse(error);
  }
}
