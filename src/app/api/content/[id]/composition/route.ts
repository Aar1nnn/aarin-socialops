import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import {
  regeneratePlatformVariant,
  rewriteContent,
  updateDraftContent,
} from "@/services/content-composition-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    switch (body.operation) {
      case "regenerate_platform":
        return Response.json(await regeneratePlatformVariant(context, id, body));
      case "rewrite":
        return Response.json(await rewriteContent(context, id, body));
      case "update_draft":
        return Response.json(await updateDraftContent(context, id, body));
      default:
        return Response.json({ error: "INVALID_COMPOSITION_OPERATION", message: "Unsupported composition operation." }, { status: 400 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
