import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { importInteraction } from "@/services/interaction-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const result = await importInteraction(context, {
      ...body,
      occurredAt: body.occurredAt || new Date(),
    });
    return actionResponse(request, result, "/insights");
  } catch (error) {
    return errorResponse(error);
  }
}
