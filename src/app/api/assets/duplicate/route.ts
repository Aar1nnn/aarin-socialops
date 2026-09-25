import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { detectDuplicateAsset } from "@/services/asset-library-service";

export async function GET(request: Request) {
  try {
    const checksum = new URL(request.url).searchParams.get("checksum") || "";
    if (!checksum) return Response.json({ error: "CHECKSUM_REQUIRED", message: "checksum is required" }, { status: 400 });
    return Response.json(await detectDuplicateAsset(await requireContext(), checksum));
  } catch (error) {
    return errorResponse(error);
  }
}
