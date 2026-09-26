import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { confirmSocialStrategy } from "@/services/social-strategy-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return actionResponse(request, await confirmSocialStrategy(await requireContext(), id), "/strategy");
  } catch (error) {
    return errorResponse(error);
  }
}
