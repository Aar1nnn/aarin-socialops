import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors";

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
};

const TOKEN_LIKE_PATTERNS = [
  /\bEAA[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|oauth.?code|client.?secret|private.?key|ciphertext|auth.?tag)/i;

export class TokenVault {
  constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly activeKeyVersion: string,
  ) {
    const activeKey = keys.get(activeKeyVersion);
    if (!activeKey || activeKey.byteLength !== 32) {
      throw new AppError("Token Vault 主密钥必须是 32 bytes。", 500, "TOKEN_VAULT_KEY_INVALID");
    }
  }

  static fromEnvironment() {
    const version = process.env.TOKEN_ENCRYPTION_KEY_VERSION || process.env.TOKEN_VAULT_KEY_VERSION || "v1";
    const raw = process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_VAULT_KEY;
    if (!raw) throw new AppError("TOKEN_ENCRYPTION_KEY 未配置。", 503, "TOKEN_VAULT_NOT_CONFIGURED");
    return new TokenVault(new Map([[version, decodeKey(raw)]]), version);
  }

  encrypt(value: string): EncryptedSecret {
    if (!value.trim()) throw new AppError("拒绝加密空凭据。", 400, "EMPTY_SECRET");
    const key = this.keys.get(this.activeKeyVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: this.activeKeyVersion,
    };
  }

  decrypt(secret: EncryptedSecret): string {
    const key = this.keys.get(secret.keyVersion);
    if (!key) throw new AppError("Token Vault key version 不可用。", 503, "TOKEN_VAULT_KEY_VERSION_MISSING");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
      decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new AppError("加密凭据无法解密或完整性校验失败。", 503, "TOKEN_VAULT_DECRYPT_FAILED");
    }
  }
}

export function encryptSecret(value: string) {
  return TokenVault.fromEnvironment().encrypt(value);
}

export function decryptSecret(secret: EncryptedSecret) {
  return TokenVault.fromEnvironment().decrypt(secret);
}

export function redactSensitiveText(value: string): string {
  return TOKEN_LIKE_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
}

export function redactSensitiveData(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveData(child),
  ]));
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.message);
  return "未分类外部连接错误。";
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.byteLength !== 32) {
    throw new AppError("TOKEN_ENCRYPTION_KEY 必须是 32-byte base64 或 64 位 hex。", 500, "TOKEN_VAULT_KEY_INVALID");
  }
  return decoded;
}
