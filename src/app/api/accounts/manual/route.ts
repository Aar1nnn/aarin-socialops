import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { createManualAccount } from "@/services/manual-account-service";

export async function POST(request: Request) {
  try {
    const result = await createManualAccount(await requireContext(), await requestData(request));
    return actionResponse(request, result, "/accounts");
  } catch (error) {
    return errorResponse(error);
  }
}
