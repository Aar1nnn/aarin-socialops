import { requireContext } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { selectPlatformAccounts } from "@/services/platform-connection-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const contentType = request.headers.get("content-type") || "";
    let accountIds: string[];
    let expectedSelectedAccountIds: string[];
    if (contentType.includes("application/json")) {
      const body = await request.json() as { accountIds?: unknown; expectedSelectedAccountIds?: unknown };
      accountIds = Array.isArray(body.accountIds) ? body.accountIds.filter((value): value is string => typeof value === "string") : [];
      expectedSelectedAccountIds = Array.isArray(body.expectedSelectedAccountIds)
        ? body.expectedSelectedAccountIds.filter((value): value is string => typeof value === "string")
        : [];
      if (!Array.isArray(body.expectedSelectedAccountIds)) {
        throw new AppError("缺少页面打开时的账号选择快照，请刷新页面后重试。", 400, "ACCOUNT_SELECTION_EXPECTED_REQUIRED");
      }
    } else {
      const form = await request.formData();
      accountIds = form.getAll("accountIds").map(String);
      expectedSelectedAccountIds = form.getAll("expectedSelectedAccountIds").map(String);
      if (form.get("selectionSnapshotPresent") !== "yes") {
        throw new AppError("缺少页面打开时的账号选择快照，请刷新页面后重试。", 400, "ACCOUNT_SELECTION_EXPECTED_REQUIRED");
      }
    }
    const result = await selectPlatformAccounts(context, id, accountIds, expectedSelectedAccountIds);
    return actionResponse(request, result, "/connections");
  } catch (error) {
    return errorResponse(error);
  }
}
