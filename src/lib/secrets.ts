import { AppError } from "./errors";

const ENV_REFERENCE = /^env:([A-Z][A-Z0-9_]*)$/;

export function resolveServerSecret(reference: string): string {
  const match = ENV_REFERENCE.exec(reference);
  if (!match) throw new AppError("凭据引用格式无效，只允许 env:VARIABLE_NAME。", 409, "INVALID_CREDENTIAL_REFERENCE");
  const value = process.env[match[1]];
  if (!value) throw new AppError("服务器未配置对应凭据。", 409, "CREDENTIAL_NOT_CONFIGURED");
  return value;
}

export function resolveFacebookSecret(reference: string): string {
  if (!/^env:FACEBOOK_[A-Z0-9_]+$/.test(reference)) {
    throw new AppError("Facebook 凭据引用必须使用 env:FACEBOOK_...。", 409, "INVALID_FACEBOOK_CREDENTIAL_REFERENCE");
  }
  return resolveServerSecret(reference);
}

export function maskSecret(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}
