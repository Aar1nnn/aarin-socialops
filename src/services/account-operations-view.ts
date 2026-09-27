import type { CapabilityStatus, PlatformConnectionStatus } from "@prisma/client";
import type { RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { manualAccountProfileUrl, resolveAccountPublishingMode } from "../lib/manual-account";

type AccountHealth = "MANUAL" | "NOT_SELECTED" | "CONNECTION_ATTENTION" | "TOKEN_ATTENTION" | "PUBLISH_UNVERIFIED" | "API_SELECTED" | "LEGACY_ACCOUNT";

export type AccountOperation = {
  id: string;
  displayName: string;
  platform: string;
  accountType: string | null;
  mode: "API" | "MANUAL";
  profileUrl: string | null;
  isSelected: boolean;
  connectionStatus: PlatformConnectionStatus | null;
  health: AccountHealth;
  issue: string;
  nextAction: string;
  nextHref: string;
  publishCapability: CapabilityStatus;
  metricsCapability: CapabilityStatus;
  commentsCapability: CapabilityStatus;
};

export async function listAccountOperations(context: RequestContext): Promise<AccountOperation[]> {
  const accounts = await db.socialAccount.findMany({
    where: { clientId: context.clientId },
    orderBy: [{ platform: "asc" }, { displayName: "asc" }, { id: "asc" }],
    select: {
      id: true,
      displayName: true,
      platform: true,
      accountType: true,
      metadata: true,
      isSelected: true,
      publishCapability: true,
      metricsCapability: true,
      commentsCapability: true,
      accessTokenCiphertext: true,
      accessTokenExpiresAt: true,
      platformConnection: { select: { status: true, accessTokenExpiresAt: true } },
    },
  });
  return accounts.map((account) => {
    const mode = resolveAccountPublishingMode(account);
    const base = {
      id: account.id,
      displayName: account.displayName,
      platform: account.platform,
      accountType: account.accountType,
      mode,
      profileUrl: manualAccountProfileUrl(account),
      isSelected: account.isSelected,
      connectionStatus: account.platformConnection?.status ?? null,
      publishCapability: account.publishCapability,
      metricsCapability: account.metricsCapability,
      commentsCapability: account.commentsCapability,
    };
    if (mode === "MANUAL") return {
      ...base,
      health: "MANUAL" as const,
      issue: "发布需由运营人员在外部平台执行并回填结果；平台 API 能力未接通。",
      nextAction: "创建人工内容",
      nextHref: "/content?create=1#new-content",
    };
    if (!account.isSelected) return {
      ...base,
      health: "NOT_SELECTED" as const,
      issue: "该账号尚未选入当前工作区运营范围。",
      nextAction: "选择账号",
      nextHref: "/connections",
    };
    if (account.platformConnection && account.platformConnection.status !== "CONNECTED") return {
      ...base,
      health: "CONNECTION_ATTENTION" as const,
      issue: `连接状态为 ${account.platformConnection.status}；请检查授权。`,
      nextAction: "检查连接",
      nextHref: "/connections",
    };
    if (!account.platformConnection) return {
      ...base,
      health: "LEGACY_ACCOUNT" as const,
      issue: "既有账号未关联新平台连接；是否可发布仍由排期校验决定。",
      nextAction: "核查账号",
      nextHref: "/connections",
    };
    if (!account.accessTokenCiphertext
      || (account.accessTokenExpiresAt && account.accessTokenExpiresAt <= new Date())
      || (account.platformConnection.accessTokenExpiresAt && account.platformConnection.accessTokenExpiresAt <= new Date())) return {
      ...base,
      health: "TOKEN_ATTENTION" as const,
      issue: "账号或连接授权缺失／到期，请检查连接；能力状态可能仍显示上次核验结果。",
      nextAction: "检查授权",
      nextHref: "/connections",
    };
    if (account.publishCapability !== "VERIFIED") return {
      ...base,
      health: "PUBLISH_UNVERIFIED" as const,
      issue: "发布能力尚未验证；指标与互动能力分别显示。",
      nextAction: "检查能力",
      nextHref: "/connections",
    };
    return {
      ...base,
      health: "API_SELECTED" as const,
      issue: "账号已选择且发布能力已验证；排期前仍会执行内容与账号校验。",
      nextAction: "进入内容中心",
      nextHref: "/content",
    };
  });
}
