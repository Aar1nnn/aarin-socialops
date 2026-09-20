import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { selectPlatformAccounts } from "@/services/platform-connection-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const contentType = request.headers.get("content-type") || "";
    let accountIds: string[];
    if (contentType.includes("application/json")) {
      const body = await request.json() as { accountIds?: unknown };
      accountIds = Array.isArray(body.accountIds) ? body.accountIds.map(String) : [];
    } else {
      const form = await request.formData();
      accountIds = form.getAll("accountIds").map(String);
    }
    const result = await selectPlatformAccounts(context, id, accountIds);
    return actionResponse(request, result, "/connections");
  } catch (error) {
    return errorResponse(error);
  }
}
