import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getAssetUsage } from "@/services/asset-library-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    return Response.json(await getAssetUsage(context, id));
  } catch (error) {
    return errorResponse(error);
  }
}
