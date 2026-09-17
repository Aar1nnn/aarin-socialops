import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { queryFacebookPublish } from "@/services/facebook-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const result = await queryFacebookPublish(context, id);
    return actionResponse(request, result, "/content");
  } catch (error) {
    return errorResponse(error);
  }
}
