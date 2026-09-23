import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import {
  compareContentVersions,
  listContentVersions,
  restoreContentVersion,
} from "@/services/content-composition-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const url = new URL(request.url);
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    if (before && after) return Response.json(await compareContentVersions(context, id, before, after));
    return Response.json(await listContentVersions(context, id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return Response.json(await restoreContentVersion(context, id, await requestData(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
