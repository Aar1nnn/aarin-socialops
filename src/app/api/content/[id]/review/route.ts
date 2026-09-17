import { ApprovalDecision } from "@prisma/client";
import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { reviewContent } from "@/services/content-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    const decision = String(body.decision) === "APPROVED" ? ApprovalDecision.APPROVED : ApprovalDecision.REJECTED;
    return actionResponse(request, await reviewContent(context, id, decision, String(body.note || "")), "/content");
  } catch (error) {
    return errorResponse(error);
  }
}
