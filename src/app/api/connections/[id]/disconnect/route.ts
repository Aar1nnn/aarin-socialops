import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { disconnectPlatformConnection } from "@/services/platform-connection-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return actionResponse(request, await disconnectPlatformConnection(context, id), "/connections");
  } catch (error) {
    return errorResponse(error);
  }
}
