import { requireContext } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { generateMonthlyOperationReport } from "@/services/report-service";

export async function POST(request: Request) {
  try {
    const input = await requestData(request);
    if (typeof input.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
      throw new AppError("请选择有效的客户时区月份。", 400, "INVALID_REVIEW_MONTH");
    }
    const report = await generateMonthlyOperationReport(await requireContext(), input.month);
    return actionResponse(request, report, `/reviews/monthly?month=${input.month}&report=${report.id}`);
  } catch (error) {
    return errorResponse(error);
  }
}
