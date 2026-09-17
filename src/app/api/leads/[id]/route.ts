import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { updateLeadStatus } from "@/services/interaction-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    return actionResponse(request, await updateLeadStatus(context, id, String(body.status || ""), String(body.feedback || "")), "/insights");
  } catch (error) {
    return errorResponse(error);
  }
}
