import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { validateFacebookPage } from "@/services/facebook-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const result = await validateFacebookPage(context, String(body.accountId || ""));
    return actionResponse(request, result, "/settings");
  } catch (error) {
    return errorResponse(error);
  }
}
