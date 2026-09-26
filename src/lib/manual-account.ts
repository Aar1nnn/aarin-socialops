import type { Prisma, SocialAccount } from "@prisma/client";

export const MANUAL_PLATFORMS = ["linkedin", "tiktok", "youtube"] as const;
export type ManualPlatform = (typeof MANUAL_PLATFORMS)[number];

type AccountModeFields = Pick<SocialAccount, "platform" | "metadata">;

function metadataObject(account: AccountModeFields): Record<string, unknown> {
  const value = account.metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveAccountPublishingMode(account: AccountModeFields): "MANUAL" | "API" {
  return MANUAL_PLATFORMS.includes(account.platform as ManualPlatform)
    && metadataObject(account).managementMode === "MANUAL"
    ? "MANUAL"
    : "API";
}

export function manualAccountProfileUrl(account: AccountModeFields): string | null {
  if (resolveAccountPublishingMode(account) !== "MANUAL") return null;
  const value = metadataObject(account).profileUrl;
  return typeof value === "string" ? value : null;
}

export function manualAccountMetadata(profileUrl: string): Prisma.InputJsonObject {
  return { managementMode: "MANUAL", profileUrl };
}
