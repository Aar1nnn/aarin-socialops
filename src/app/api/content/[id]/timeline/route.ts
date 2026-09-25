import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getContentTimeline } from "@/services/approval-collaboration-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return Response.json(await getContentTimeline(context, id));
  } catch (error) {
    return errorResponse(error);
  }
}
