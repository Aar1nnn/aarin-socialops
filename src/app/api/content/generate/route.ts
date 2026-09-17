import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { generateContentPlan } from "@/services/content-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const result = await generateContentPlan(context, {
      productId: body.productId,
      theme: body.theme,
      objective: body.objective,
      platforms: typeof body.platforms === "string"
        ? String(body.platforms).split(",").filter(Boolean)
        : body.platforms,
      assetIds: typeof body.assetIds === "string"
        ? String(body.assetIds).split(",").filter(Boolean)
        : body.assetIds || [],
      plannedAt: body.plannedAt || undefined,
    });
    return actionResponse(request, result, "/content");
  } catch (error) {
    return errorResponse(error);
  }
}
