import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { queryPlatformPublish } from "@/services/platform-publish-query-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const result = await queryPlatformPublish(context, id);
    return actionResponse(request, result, "/content");
  } catch (error) {
    return errorResponse(error);
  }
}
