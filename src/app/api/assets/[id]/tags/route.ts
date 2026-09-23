import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { setAssetTags } from "@/services/asset-library-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return Response.json(await setAssetTags(context, id, await requestData(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
