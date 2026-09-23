import { CapabilityStatus } from "@prisma/client";
import { InstagramGraphAdapter } from "../lib/adapters/instagram-graph";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { TokenVault } from "../lib/token-vault";

export async function getInstagramAdapterForJob(clientId: string, accountId: string) {
  const account = await db.socialAccount.findFirst({
    where: { id: accountId, clientId, platform: "instagram" },
    include: { platformConnection: true },
  });
  if (!account || account.clientId !== clientId) {
    throw new AppError("Instagram 账号不存在或无权访问。", 404, "INSTAGRAM_ACCOUNT_NOT_FOUND");
  }
  const connection = account.platformConnection;
  if (
    !connection ||
    connection.provider !== "META" ||
    connection.status !== "CONNECTED" ||
    !account.isSelected ||
    account.publishCapability !== CapabilityStatus.VERIFIED ||
    !account.externalAccountId ||
    !account.accessTokenCiphertext ||
    !account.accessTokenIv ||
    !account.accessTokenAuthTag
  ) {
    throw new AppError("Instagram OAuth 账号连接未验证或加密凭据不可用。", 409, "META_CONNECTION_UNAVAILABLE");
  }
  if (account.accessTokenExpiresAt && account.accessTokenExpiresAt <= new Date()) {
    await db.$transaction([
      db.platformConnection.update({
        where: { id: connection.id },
        data: {
          status: "TOKEN_EXPIRED",
          lastErrorCode: "TOKEN_EXPIRED",
          lastErrorMessage: "Instagram access token 已到期，请重新连接 Meta。",
        },
      }),
      db.socialAccount.update({
        where: { id: account.id },
        data: { publishCapability: "UNVERIFIED", verifiedAt: null },
      }),
    ]);
    throw new AppError("Instagram access token 已到期，请重新连接 Meta。", 409, "TOKEN_EXPIRED");
  }
  const accessToken = TokenVault.fromEnvironment().decrypt({
    ciphertext: account.accessTokenCiphertext,
    iv: account.accessTokenIv,
    authTag: account.accessTokenAuthTag,
    keyVersion: connection.tokenKeyVersion,
  });
  return new InstagramGraphAdapter({
    igUserId: account.externalAccountId,
    accessToken,
    apiVersion: process.env.META_GRAPH_API_VERSION || process.env.FACEBOOK_GRAPH_API_VERSION || "v26.0",
    baseUrl: process.env.META_GRAPH_BASE_URL || process.env.FACEBOOK_GRAPH_BASE_URL,
    timeoutMs: Number(process.env.META_REQUEST_TIMEOUT_MS || 30_000),
  });
}
