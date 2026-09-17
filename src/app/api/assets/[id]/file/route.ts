import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const asset = await db.asset.findFirst({ where: { id, clientId: context.clientId } });
    if (!asset) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
    const root = path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_LOCAL_ROOT || "./storage");
    const absolute = path.resolve(root, asset.storageKey);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new AppError("素材路径无效。", 500, "INVALID_STORAGE_PATH");
    const body = await readFile(/* turbopackIgnore: true */ absolute);
    return new Response(body, {
      headers: {
        "content-type": asset.mimeType,
        "content-disposition": `inline; filename="${encodeURIComponent(asset.originalName)}"`,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
