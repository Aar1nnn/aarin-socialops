import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse } from "@/lib/http";
import { uploadAsset } from "@/services/product-service";

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
