import { Readable } from "node:stream";
import { getStorageAdapter } from "@/lib/adapters/storage";
import { requireContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const asset = await db.asset.findFirst({ where: { id, clientId: context.clientId } });
    if (!asset) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
    const stream = await getStorageAdapter(asset.storageProvider).getStream(asset.storageKey);
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "content-type": asset.mimeType, "content-length": String(asset.byteSize), "content-disposition": `inline; filename="${encodeURIComponent(asset.originalName)}"`, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" } });
  } catch (error) {
    return errorResponse(error);
  }
}
