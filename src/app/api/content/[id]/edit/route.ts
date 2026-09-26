import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { editContentVersion } from "@/services/content-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    const result = await editContentVersion(context, id, {
      text: String(body.text || ""),
      title: body.title === undefined ? undefined : String(body.title || ""),
      accountId: body.accountId ? String(body.accountId) : undefined,
      expectedVersionId: typeof body.expectedVersionId === "string" ? body.expectedVersionId : undefined,
    });
    return actionResponse(request, result, `/content/${id}`);
  } catch (error) {
    return errorResponse(error);
  }
}
