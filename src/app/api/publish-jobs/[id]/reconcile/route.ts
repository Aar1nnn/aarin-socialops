import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { reconcileUnknownPublish } from "@/services/publish-worker-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const result = await reconcileUnknownPublish(context, id, await requestData(request));
    return actionResponse(request, result, "/publishing");
  } catch (error) {
    return errorResponse(error);
  }
}
