import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { listNotificationRules, upsertNotificationRule } from "@/services/notification-service";

export async function GET() {
  try { return Response.json(await listNotificationRules(await requireContext())); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try { return Response.json(await upsertNotificationRule(await requireContext(), await requestData(request))); }
  catch (error) { return errorResponse(error); }
}
