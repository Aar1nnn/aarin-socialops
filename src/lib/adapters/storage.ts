import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../errors";

export type SupportedMediaType = "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/quicktime";
export type StoredAsset = { storageProvider: "local" | "s3"; storageKey: string; checksum: string; byteSize: number; mimeType: SupportedMediaType };
export type StoragePutInput = { key: string; body: Readable; contentType: string; contentLength?: number };
export type StoragePutResult = { checksum: string; byteSize: number; detectedMimeType: SupportedMediaType | null };
export type StorageObjectMetadata = { contentLength: number | null; contentType: string | null };
export type MediaAvailability = "LOCAL_ONLY" | "PRIVATE_REMOTE" | "PUBLIC_HTTPS" | "SIGNED_HTTPS" | "UNAVAILABLE";
export type ExternalReadSource = "NONE" | "METADATA_PUBLIC_URL" | "METADATA_SIGNED_URL" | "STORAGE_SIGNED_URL";
export type ExternalReadReason =
  | "READY_CANDIDATE"
  | "STORAGE_KEY_MISSING"
  | "LOCAL_STORAGE"
  | "REMOTE_URL_MISSING"
  | "URL_INVALID"
  | "HTTPS_REQUIRED"
  | "URL_CREDENTIALS_FORBIDDEN"
  | "HOST_NOT_PUBLIC"
  | "SIGNED_URL_EXPIRY_UNKNOWN"
  | "SIGNED_URL_EXPIRY_INVALID"
  | "SIGNED_URL_EXPIRED"
  | "SIGNED_URL_EXPIRES_TOO_SOON";
export type ExternalReadAssessment = {
  availability: MediaAvailability;
  ready: boolean;
  externalValidation: "NOT_EXTERNALLY_VERIFIED";
  source: ExternalReadSource;
  reason: ExternalReadReason;
  message: string;
  expiresAt: string | null;
  url: string | null;
};
export type ExternalReadDescriptor = Omit<ExternalReadAssessment, "url">;
export type ExternalReadOptions = {
  expiresSeconds?: number;
  minimumValiditySeconds?: number;
  now?: Date;
};

export const DEFAULT_EXTERNAL_READ_MINIMUM_VALIDITY_SECONDS = 15 * 60;

type ExternalReadCandidateOptions = ExternalReadOptions & {
  candidateType: "PUBLIC_HTTPS" | "SIGNED_HTTPS";
  source: Exclude<ExternalReadSource, "NONE">;
  explicitExpiresAt?: unknown;
  fallbackAvailability?: Exclude<MediaAvailability, "PUBLIC_HTTPS" | "SIGNED_HTTPS">;
};

type AssetExternalReadInput = {
  storageProvider?: string;
  storageKey: string;
  metadata?: unknown;
};

export interface StorageAdapter {
  readonly provider: "local" | "s3";
  put(input: StoragePutInput): Promise<StoragePutResult>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresSeconds?: number): Promise<string | null>;
  getExternalRead(key: string, options?: ExternalReadOptions): Promise<ExternalReadAssessment>;
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
  async getExternalRead(key: string) { return assessAssetExternalRead({ storageProvider: "local", storageKey: key }); }
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
  async getExternalRead(key: string, options: ExternalReadOptions = {}) {
    if (!key) return unavailableAssessment("UNAVAILABLE", "STORAGE_KEY_MISSING", "素材缺少存储键。", "NONE");
    const expiresSeconds = options.expiresSeconds ?? 3_600;
    const url = await this.presign("GET", key, expiresSeconds);
    return assessExternalReadUrl(url, {
      ...options,
      candidateType: "SIGNED_HTTPS",
      source: "STORAGE_SIGNED_URL",
      fallbackAvailability: "PRIVATE_REMOTE",
    });
  }
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

export async function resolveStorageExternalRead(
  asset: Pick<AssetExternalReadInput, "storageProvider" | "storageKey">,
  options: ExternalReadOptions = {},
) {
  return getStorageAdapter(asset.storageProvider || "local").getExternalRead(asset.storageKey, options);
}

export function assessAssetExternalRead(asset: AssetExternalReadInput, options: ExternalReadOptions = {}): ExternalReadAssessment {
  if (!asset.storageKey) return unavailableAssessment("UNAVAILABLE", "STORAGE_KEY_MISSING", "素材缺少存储键。", "NONE");
  const fallbackAvailability = asset.storageProvider === "local" ? "LOCAL_ONLY" : "PRIVATE_REMOTE";
  const metadata = jsonObject(asset.metadata);
  const explicitExpiresAt = firstDefined(metadata, ["signedUrlExpiresAt", "signedUrlExpiration", "urlExpiresAt", "expiresAt"]);
  const candidates: ExternalReadAssessment[] = [];
  if (typeof metadata.publicUrl === "string" && metadata.publicUrl.trim()) {
    candidates.push(assessExternalReadUrl(metadata.publicUrl, {
      ...options,
      candidateType: "PUBLIC_HTTPS",
      source: "METADATA_PUBLIC_URL",
      explicitExpiresAt,
      fallbackAvailability,
    }));
  }
  if (typeof metadata.signedUrl === "string" && metadata.signedUrl.trim()) {
    candidates.push(assessExternalReadUrl(metadata.signedUrl, {
      ...options,
      candidateType: "SIGNED_HTTPS",
      source: "METADATA_SIGNED_URL",
      explicitExpiresAt,
      fallbackAvailability,
    }));
  }
  return candidates.find((candidate) => candidate.ready)
    ?? candidates.find((candidate) => candidate.availability === "PUBLIC_HTTPS" || candidate.availability === "SIGNED_HTTPS")
    ?? candidates[0]
    ?? unavailableAssessment(
      fallbackAvailability,
      fallbackAvailability === "LOCAL_ONLY" ? "LOCAL_STORAGE" : "REMOTE_URL_MISSING",
      fallbackAvailability === "LOCAL_ONLY"
        ? "本地素材没有可供外部平台拉取的 HTTPS 地址。"
        : "远端素材没有可评估的外部读取地址。",
      "NONE",
    );
}

export function assessExternalReadUrl(rawUrl: string | null | undefined, options: ExternalReadCandidateOptions): ExternalReadAssessment {
  const fallback = options.fallbackAvailability ?? "UNAVAILABLE";
  if (!rawUrl?.trim()) return unavailableAssessment(fallback, "REMOTE_URL_MISSING", "素材没有可评估的外部读取地址。", options.source);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return unavailableAssessment(fallback, "URL_INVALID", "素材外部读取地址不是有效 URL。", options.source);
  }
  if (parsed.protocol !== "https:") return unavailableAssessment(fallback, "HTTPS_REQUIRED", "素材外部读取地址必须使用 HTTPS。", options.source);
  if (parsed.username || parsed.password) return unavailableAssessment(fallback, "URL_CREDENTIALS_FORBIDDEN", "素材外部读取地址不得包含 URL 用户名或密码。", options.source);
  if (!isPublicHostname(parsed.hostname)) return unavailableAssessment(fallback, "HOST_NOT_PUBLIC", "素材外部读取地址不能指向本机、私有或链路本地地址。", options.source);

  const signed = options.candidateType === "SIGNED_HTTPS" || options.explicitExpiresAt !== undefined || hasSigningEvidence(parsed);
  const availability: MediaAvailability = signed ? "SIGNED_HTTPS" : "PUBLIC_HTTPS";
  if (signed) {
    const expiry = signedUrlExpiry(parsed, options.explicitExpiresAt);
    if (expiry.status === "UNKNOWN") {
      return unavailableAssessment(availability, "SIGNED_URL_EXPIRY_UNKNOWN", "签名素材地址缺少可识别的过期时间。", options.source, parsed.toString());
    }
    if (expiry.status === "INVALID") {
      return unavailableAssessment(availability, "SIGNED_URL_EXPIRY_INVALID", "签名素材地址的过期时间无效。", options.source, parsed.toString());
    }
    const now = options.now ?? new Date();
    const expiresAt = expiry.expiresAt;
    if (expiresAt.getTime() <= now.getTime()) {
      return unavailableAssessment(availability, "SIGNED_URL_EXPIRED", "签名素材地址已过期。", options.source, parsed.toString(), expiresAt);
    }
    const minimumValiditySeconds = options.minimumValiditySeconds ?? DEFAULT_EXTERNAL_READ_MINIMUM_VALIDITY_SECONDS;
    if (expiresAt.getTime() - now.getTime() <= minimumValiditySeconds * 1_000) {
      return unavailableAssessment(availability, "SIGNED_URL_EXPIRES_TOO_SOON", "签名素材地址剩余有效期不足以安全交给外部平台拉取。", options.source, parsed.toString(), expiresAt);
    }
    return readyAssessment(availability, options.source, parsed.toString(), expiresAt);
  }
  return readyAssessment(availability, options.source, parsed.toString());
}

export function externalReadDescriptor(assessment: ExternalReadAssessment): ExternalReadDescriptor {
  const { url: _url, ...descriptor } = assessment;
  return descriptor;
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

function readyAssessment(
  availability: "PUBLIC_HTTPS" | "SIGNED_HTTPS",
  source: Exclude<ExternalReadSource, "NONE">,
  url: string,
  expiresAt?: Date,
): ExternalReadAssessment {
  return {
    availability,
    ready: true,
    externalValidation: "NOT_EXTERNALLY_VERIFIED",
    source,
    reason: "READY_CANDIDATE",
    message: "地址通过本地安全与有效期检查，但尚未经过目标平台外部拉取验证。",
    expiresAt: expiresAt?.toISOString() ?? null,
    url,
  };
}

function unavailableAssessment(
  availability: MediaAvailability,
  reason: Exclude<ExternalReadReason, "READY_CANDIDATE">,
  message: string,
  source: ExternalReadSource,
  url: string | null = null,
  expiresAt?: Date,
): ExternalReadAssessment {
  return {
    availability,
    ready: false,
    externalValidation: "NOT_EXTERNALLY_VERIFIED",
    source,
    reason,
    message,
    expiresAt: expiresAt?.toISOString() ?? null,
    url,
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstDefined(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function hasSigningEvidence(url: URL) {
  const keys = new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()));
  return [
    "x-amz-signature", "x-amz-credential", "x-goog-signature", "x-goog-credential",
    "x-oss-signature", "q-signature", "signature", "sig", "key-pair-id", "q-sign-time", "q-key-time",
    "x-amz-expires", "x-goog-expires", "x-oss-expires", "se", "expires", "expiry", "expires_at", "exp",
  ].some((key) => keys.has(key));
}

type ExpiryResult =
  | { status: "KNOWN"; expiresAt: Date }
  | { status: "UNKNOWN" }
  | { status: "INVALID" };

function signedUrlExpiry(url: URL, explicitExpiresAt: unknown): ExpiryResult {
  if (explicitExpiresAt !== undefined) {
    const explicit = parseExpiryValue(explicitExpiresAt);
    return explicit ? { status: "KNOWN", expiresAt: explicit } : { status: "INVALID" };
  }
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) values.set(key.toLowerCase(), value);

  const awsDate = values.get("x-amz-date");
  const awsDuration = values.get("x-amz-expires");
  if (awsDate || awsDuration) return relativeSignedExpiry(awsDate, awsDuration);

  const googleDate = values.get("x-goog-date");
  const googleDuration = values.get("x-goog-expires");
  if (googleDate || googleDuration) return relativeSignedExpiry(googleDate, googleDuration);

  const ossDate = values.get("x-oss-date");
  const ossDuration = values.get("x-oss-expires");
  if (ossDate || ossDuration) return relativeSignedExpiry(ossDate, ossDuration);

  const signedTime = values.get("q-sign-time") || values.get("q-key-time");
  if (signedTime) {
    const [, end] = signedTime.split(";");
    const parsed = parseExpiryValue(end);
    return parsed ? { status: "KNOWN", expiresAt: parsed } : { status: "INVALID" };
  }

  for (const key of ["se", "expires", "expiry", "expires_at", "exp"]) {
    if (!values.has(key)) continue;
    const parsed = parseExpiryValue(values.get(key));
    return parsed ? { status: "KNOWN", expiresAt: parsed } : { status: "INVALID" };
  }
  return { status: "UNKNOWN" };
}

function relativeSignedExpiry(rawDate: string | undefined, rawDuration: string | undefined): ExpiryResult {
  if (!rawDate || !rawDuration) return { status: "INVALID" };
  const start = parseCompactUtc(rawDate);
  const durationSeconds = Number(rawDuration);
  if (!start || !Number.isFinite(durationSeconds) || durationSeconds < 0) return { status: "INVALID" };
  return { status: "KNOWN", expiresAt: new Date(start.getTime() + durationSeconds * 1_000) };
}

function parseCompactUtc(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  return parsed.getUTCFullYear() === parts[0]
    && parsed.getUTCMonth() === parts[1] - 1
    && parsed.getUTCDate() === parts[2]
    && parsed.getUTCHours() === parts[3]
    && parsed.getUTCMinutes() === parts[4]
    && parsed.getUTCSeconds() === parts[5]
    ? parsed
    : null;
}

function parseExpiryValue(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return finiteEpoch(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return finiteEpoch(Number(normalized));
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function finiteEpoch(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const parsed = new Date(value >= 1_000_000_000_000 ? value : value * 1_000);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isPublicHostname(rawHostname: string) {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "localhost.localdomain" || hostname.endsWith(".localdomain") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".lan")) return false;
  const version = isIP(hostname);
  if (version === 4) return isPublicIpv4(hostname);
  if (version === 6) return isPublicIpv6(hostname);
  return true;
}

function isPublicIpv4(address: string) {
  const bytes = address.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = bytes;
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  );
}

function isPublicIpv6(address: string) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
  if (bytes[0] === 0xff) return false;
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (ipv4Mapped) return isPublicIpv4(bytes.slice(12).join("."));
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (ipv4Compatible) return isPublicIpv4(bytes.slice(12).join("."));
  return true;
}

function ipv6Bytes(address: string) {
  const withoutZone = address.split("%")[0];
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => half ? half.split(":") : [];
  let left = parseHalf(halves[0]);
  let right = parseHalf(halves[1] || "");
  const convertIpv4Tail = (parts: string[]) => {
    const tail = parts.at(-1);
    if (!tail?.includes(".")) return parts;
    if (!isIP(tail)) return [];
    const octets = tail.split(".").map(Number);
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  left = convertIpv4Tail(left);
  right = convertIpv4Tail(right);
  if ((!left.length && halves[0]) || (!right.length && halves[1])) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
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
