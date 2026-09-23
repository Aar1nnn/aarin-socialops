import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { uploadAsset } from "@/services/product-service";
import { searchAssets } from "@/services/asset-library-service";

export async function GET(request: Request) {
  try {
    const context = await requireContext();
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    return Response.json(await searchAssets(context, { ...query, tagIds: query.tagIds?.split(",").filter(Boolean) }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 200 * 1024 * 1024);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > maxBytes + 1024 * 1024) {
      return Response.json({ error: "ASSET_TOO_LARGE", message: `请求超过上传上限 ${maxBytes} bytes。` }, { status: 413 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "FILE_REQUIRED", message: "请选择文件。" }, { status: 400 });
    const asset = await uploadAsset(context, { file, productId: String(form.get("productId") || "") || undefined });
    return actionResponse(request, asset, "/products");
  } catch (error) {
    return errorResponse(error);
  }
}
