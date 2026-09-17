import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { syncFacebookComments } from "@/services/facebook-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const result = await syncFacebookComments(context, String(body.publishJobId || ""));
    return actionResponse(request, result, "/insights");
  } catch (error) {
    return errorResponse(error);
  }
}
