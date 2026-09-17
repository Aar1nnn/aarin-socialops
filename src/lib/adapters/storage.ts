import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import { sha256 } from "../security";

export type StoredAsset = {
  storageProvider: "local";
  storageKey: string;
  checksum: string;
  byteSize: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/quicktime";
};

function detectMediaType(bytes: Buffer): StoredAsset["mimeType"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return null;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "asset";
}

export function resolveLocalAssetPath(storageKey: string): string {
  const root = path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_LOCAL_ROOT || "./storage");
  const absolute = path.resolve(root, storageKey);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new AppError("素材存储路径无效。", 400, "INVALID_STORAGE_PATH");
  }
  return absolute;
}

export async function storeLocalAsset(clientId: string, file: File): Promise<StoredAsset> {
  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 200 * 1024 * 1024);
  if (file.size > maxBytes) throw new AppError(`素材超过上传上限 ${maxBytes} bytes。`, 413, "ASSET_TOO_LARGE");
  const root = path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_LOCAL_ROOT || "./storage");
  const folder = path.resolve(root, safeSegment(clientId));
  if (!folder.startsWith(`${root}${path.sep}`)) {
    throw new AppError("素材存储路径无效。", 400, "INVALID_STORAGE_PATH");
  }
  await mkdir(folder, { recursive: true });
  const bytes = Buffer.from(await file.arrayBuffer());
  const mimeType = detectMediaType(bytes);
  if (!mimeType) {
    throw new AppError("文件内容不是受支持的 PNG、JPEG、WebP、MP4 或 QuickTime 素材。", 400, "UNSUPPORTED_ASSET_CONTENT");
  }
  const storageKey = path.join(safeSegment(clientId), `${randomUUID()}-${safeSegment(file.name)}`);
  const absolute = path.resolve(root, storageKey);
  if (!absolute.startsWith(`${folder}${path.sep}`)) {
    throw new AppError("素材文件名无效。", 400, "INVALID_ASSET_NAME");
  }
  await writeFile(absolute, bytes, { flag: "wx" });
  return {
    storageProvider: "local",
    storageKey: storageKey.replaceAll("\\", "/"),
    checksum: sha256(bytes),
    byteSize: bytes.length,
    mimeType,
  };
}
