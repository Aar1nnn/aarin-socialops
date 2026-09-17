import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { submitForReview } from "@/services/content-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return actionResponse(request, await submitForReview(context, id), "/content");
  } catch (error) {
    return errorResponse(error);
  }
}
