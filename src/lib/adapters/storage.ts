import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../errors";

export type SupportedMediaType = "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/quicktime";
export type StoredAsset = { storageProvider: "local" | "s3"; storageKey: string; checksum: string; byteSize: number; mimeType: SupportedMediaType };
export type StoragePutInput = { key: string; body: Readable; contentType: string; contentLength?: number };
export type StoragePutResult = { checksum: string; byteSize: number; detectedMimeType: SupportedMediaType | null };
export type StorageObjectMetadata = { contentLength: number | null; contentType: string | null };

export interface StorageAdapter {
  readonly provider: "local" | "s3";
  put(input: StoragePutInput): Promise<StoragePutResult>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresSeconds?: number): Promise<string | null>;
  metadata(key: string): Promise<StorageObjectMetadata>;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = "local" as const;
  constructor(private readonly root = path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_LOCAL_ROOT || "./storage")) {}

  async put(input: StoragePutInput): Promise<StoragePutResult> {
    const absolute = this.resolve(input.key);
    await mkdir(path.dirname(absolute), { recursive: true });
    const inspector = createInspectionTransform();
    try {
      await pipeline(input.body, inspector.stream, createWriteStream(absolute, { flags: "wx" }));
      return inspector.result();
    } catch (error) {
      await rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async getStream(key: string) { return createReadStream(this.resolve(key)); }
  async delete(key: string) { await rm(this.resolve(key), { force: true }); }
  async getSignedUrl() { return null; }
  async metadata(key: string) { const file = await stat(this.resolve(key)); return { contentLength: file.size, contentType: null }; }

  resolve(key: string) {
    const absolute = path.resolve(this.root, key);
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new AppError("素材存储路径无效。", 400, "INVALID_STORAGE_PATH");
    return absolute;
  }
}

type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; fetchImpl?: typeof fetch };

export class S3CompatibleStorageAdapter implements StorageAdapter {
  readonly provider = "s3" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly config: S3Config) {
    if (!config.endpoint || !config.bucket || !config.region || !config.accessKeyId || !config.secretAccessKey) throw new AppError("S3-compatible 存储配置不完整。", 503, "S3_STORAGE_NOT_CONFIGURED");
    this.fetchImpl = config.fetchImpl || fetch;
  }

  async put(input: StoragePutInput): Promise<StoragePutResult> {
    const inspector = createInspectionTransform();
    const response = await this.fetchImpl(await this.presign("PUT", input.key, 900), {
      method: "PUT",
      headers: { "content-type": input.contentType },
      body: input.body.pipe(inspector.stream) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new AppError(`S3 上传失败：HTTP ${response.status}`, 502, "S3_UPLOAD_FAILED");
    return inspector.result();
  }

  async getStream(key: string) {
    const response = await this.fetchImpl(await this.presign("GET", key, 900));
    if (!response.ok || !response.body) throw new AppError(`S3 读取失败：HTTP ${response.status}`, 502, "S3_READ_FAILED");
    return Readable.fromWeb(response.body as never);
  }

  async delete(key: string) {
    const response = await this.fetchImpl(await this.presign("DELETE", key, 900), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new AppError(`S3 删除失败：HTTP ${response.status}`, 502, "S3_DELETE_FAILED");
  }
  async getSignedUrl(key: string, expiresSeconds = 900) { return this.presign("GET", key, expiresSeconds); }
  async metadata(key: string) {
    const response = await this.fetchImpl(await this.presign("HEAD", key, 300), { method: "HEAD" });
    if (!response.ok) throw new AppError(`S3 metadata 读取失败：HTTP ${response.status}`, 502, "S3_METADATA_FAILED");
    const contentLength = response.headers.get("content-length");
    return { contentLength: contentLength ? Number(contentLength) : null, contentType: response.headers.get("content-type") };
  }

  private async presign(method: string, key: string, expiresSeconds: number) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const endpoint = new URL(this.config.endpoint);
    const canonicalUri = `/${encodeURIComponent(this.config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(Math.min(Math.max(expiresSeconds, 1), 604800)),
      "X-Amz-SignedHeaders": "host",
    });
    if (this.config.sessionToken) params.set("X-Amz-Security-Token", this.config.sessionToken);
    const canonicalQuery = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${endpoint.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    endpoint.pathname = canonicalUri;
    endpoint.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return endpoint.toString();
  }
}

export function getStorageAdapter(provider = process.env.STORAGE_PROVIDER || "local"): StorageAdapter {
  if (provider === "local") return new LocalStorageAdapter();
  if (provider === "s3") return new S3CompatibleStorageAdapter({ endpoint: process.env.S3_ENDPOINT || "", bucket: process.env.S3_BUCKET || "", region: process.env.S3_REGION || "", accessKeyId: process.env.S3_ACCESS_KEY_ID || "", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "", sessionToken: process.env.S3_SESSION_TOKEN });
  throw new AppError(`未知存储 provider：${provider}`, 503, "STORAGE_PROVIDER_UNSUPPORTED");
}

export function resolveLocalAssetPath(storageKey: string): string { return new LocalStorageAdapter().resolve(storageKey); }

export async function storeAsset(clientId: string, file: File): Promise<StoredAsset> {
  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 200 * 1024 * 1024);
  if (file.size > maxBytes) throw new AppError(`素材超过上传上限 ${maxBytes} bytes。`, 413, "ASSET_TOO_LARGE");
  const adapter = getStorageAdapter();
  const storageKey = `${safeSegment(clientId)}/${randomUUID()}-${safeSegment(file.name)}`;
  const result = await adapter.put({ key: storageKey, body: Readable.fromWeb(file.stream() as never), contentType: file.type || "application/octet-stream", contentLength: file.size });
  if (!result.detectedMimeType) {
    await adapter.delete(storageKey).catch(() => undefined);
    throw new AppError("文件内容不是受支持的 PNG、JPEG、WebP、MP4 或 QuickTime 素材。", 400, "UNSUPPORTED_ASSET_CONTENT");
  }
  return { storageProvider: adapter.provider, storageKey, checksum: result.checksum, byteSize: result.byteSize, mimeType: result.detectedMimeType };
}

export const storeLocalAsset = storeAsset;

export function detectMediaType(bytes: Buffer): SupportedMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return bytes.subarray(8, 12).toString("ascii") === "qt  " ? "video/quicktime" : "video/mp4";
  return null;
}

function createInspectionTransform() {
  const hash = createHash("sha256"); let byteSize = 0; let prefix = Buffer.alloc(0); let completed = false; let digest = "";
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); byteSize += bytes.length; hash.update(bytes); if (prefix.length < 64) prefix = Buffer.concat([prefix, bytes.subarray(0, 64 - prefix.length)]); callback(null, bytes); } });
  stream.on("finish", () => { digest = hash.digest("hex"); completed = true; });
  return { stream, result(): StoragePutResult { if (!completed) throw new AppError("素材流尚未完成。", 500, "STORAGE_STREAM_INCOMPLETE"); return { checksum: digest, byteSize, detectedMimeType: detectMediaType(prefix) }; } };
}

function safeSegment(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "asset"; }
function sha256Hex(value: string) { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string) { return createHmac("sha256", key).update(value).digest(); }
