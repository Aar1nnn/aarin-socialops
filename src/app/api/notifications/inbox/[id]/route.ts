import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { setNotificationReadState } from "@/services/notification-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await requestData(request);
    const { id } = await params;
    return Response.json(await setNotificationReadState(await requireContext(), id, body.read === true || body.read === "true"));
  } catch (error) { return errorResponse(error); }
}
