import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { confirmBrandAutofill, createBrandAutofillDraft } from "@/services/brand-autofill-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    if (body.operation === "analyze") return Response.json(await createBrandAutofillDraft(context, body));
    if (body.operation === "confirm") return Response.json(await confirmBrandAutofill(context, body));
    return Response.json({ error: "INVALID_BRAND_AUTOFILL_OPERATION", message: "Unsupported brand autofill operation." }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
