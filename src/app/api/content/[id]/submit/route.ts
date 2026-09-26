import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { submitForReview } from "@/services/content-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    return actionResponse(request, await submitForReview(context, id, typeof body.expectedVersionId === "string" ? body.expectedVersionId : undefined), `/content/${id}`);
  } catch (error) {
    return errorResponse(error);
  }
}
