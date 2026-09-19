import { randomBytes } from "node:crypto";
import { CapabilityStatus, type Prisma, type Provider } from "@prisma/client";
import { createMetaAuthAdapter } from "../lib/adapters/meta-auth";
import { PlatformAuthError, type PlatformAuthAdapter } from "../lib/adapters/platform-auth";
import { assertOwner, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { sha256 } from "../lib/security";
import { safeErrorMessage, TokenVault, type EncryptedSecret } from "../lib/token-vault";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export async function startPlatformConnection(
  context: RequestContext,
  provider: Provider,
  returnTo = "/connections",
  adapterOverride?: PlatformAuthAdapter,
) {
  assertOwner(context);
  const adapter = adapterOverride || getAuthAdapter(provider);
  const redirectUri = configuredRedirectUri(provider);
  const safeReturnTo = normalizeReturnTo(returnTo);
  const state = randomBytes(32).toString("base64url");
  await db.oAuthState.create({
    data: {
      stateHash: sha256(state),
      provider,
      clientId: context.clientId,
      userId: context.userId,
      redirectUri,
      returnTo: safeReturnTo,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  });
  const authorizationUrl = adapter.buildAuthorizationUrl({ state, redirectUri });
  await db.auditLog.create({
    data: {
      clientId: context.clientId,
      userId: context.userId,
      action: "PLATFORM_OAUTH_STARTED",
      entityType: "OAuthState",
      entityId: sha256(state).slice(0, 12),
      metadata: { provider, returnTo: safeReturnTo },
    },
  });
  return { authorizationUrl: authorizationUrl.toString() };
}

export async function completePlatformConnection(
  context: RequestContext,
  provider: Provider,
  input: { code: string; state: string },
  overrides: { adapter?: PlatformAuthAdapter; vault?: TokenVault } = {},
) {
  assertOwner(context);
  if (!input.code || !input.state) throw new AppError("OAuth callback 缺少 code 或 state。", 400, "OAUTH_CALLBACK_INVALID");
  const stateHash = sha256(input.state);
  const stateRecord = await db.$transaction(async (tx) => {
    const consumed = await tx.oAuthState.updateMany({
      where: {
        stateHash,
        provider,
        clientId: context.clientId,
        userId: context.userId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new AppError("OAuth state 已过期、已使用或不属于当前客户。", 400, "OAUTH_STATE_INVALID");
    return tx.oAuthState.findUniqueOrThrow({ where: { stateHash } });
  });

  const adapter = overrides.adapter || getAuthAdapter(provider);
  const vault = overrides.vault || TokenVault.fromEnvironment();
  try {
    const tokenSet = await adapter.exchangeCode(input.code, stateRecord.redirectUri);
    const discovery = await adapter.discoverAccounts(tokenSet.accessToken);
    const accessSecret = vault.encrypt(tokenSet.accessToken);
    const refreshSecret = tokenSet.refreshToken ? vault.encrypt(tokenSet.refreshToken) : null;
    const connection = await db.$transaction(async (tx) => {
      const requestedScopes = (process.env.META_OAUTH_SCOPES || "pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content")
        .split(",").map((scope) => scope.trim()).filter(Boolean);
      const missingScopes = requestedScopes.filter((scope) => !discovery.grantedScopes.includes(scope));
      const connectionData = {
        externalPrincipalId: discovery.externalPrincipalId,
        ...connectionTokenData(accessSecret, refreshSecret),
        accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
        scopes: discovery.grantedScopes.length ? discovery.grantedScopes : tokenSet.scopes,
        status: missingScopes.length ? "PERMISSION_MISSING" as const : "CONNECTED" as const,
        connectedByUserId: context.userId,
        connectedAt: new Date(),
        lastErrorCode: missingScopes.length ? "PERMISSION_MISSING" : null,
        lastErrorMessage: missingScopes.length ? `缺少授权范围：${missingScopes.join(", ")}` : null,
      };
      const saved = await tx.platformConnection.upsert({
        where: {
          clientId_provider_externalPrincipalId: {
            clientId: context.clientId,
            provider,
            externalPrincipalId: discovery.externalPrincipalId,
          },
        },
        update: connectionData,
        create: { clientId: context.clientId, provider, ...connectionData },
      });

      const discoveredIdentities = discovery.accounts.map((account) => ({
        platform: account.platform,
        externalAccountId: account.externalAccountId,
      }));
      if (discoveredIdentities.length) {
        await tx.socialAccount.updateMany({
          where: {
            clientId: context.clientId,
            platformConnectionId: saved.id,
            NOT: { OR: discoveredIdentities },
          },
          data: {
            isSelected: false,
            accessTokenCiphertext: null,
            accessTokenIv: null,
            accessTokenAuthTag: null,
            accessTokenExpiresAt: null,
            publishCapability: CapabilityStatus.UNVERIFIED,
            metricsCapability: CapabilityStatus.UNVERIFIED,
            commentsCapability: CapabilityStatus.UNVERIFIED,
            verifiedAt: null,
          },
        });
      } else {
        await tx.socialAccount.updateMany({
          where: { clientId: context.clientId, platformConnectionId: saved.id },
          data: {
            isSelected: false,
            accessTokenCiphertext: null,
            accessTokenIv: null,
            accessTokenAuthTag: null,
            accessTokenExpiresAt: null,
            publishCapability: CapabilityStatus.UNVERIFIED,
            metricsCapability: CapabilityStatus.UNVERIFIED,
            commentsCapability: CapabilityStatus.UNVERIFIED,
            verifiedAt: null,
          },
        });
      }

      for (const account of discovery.accounts) {
        const accountSecret = vault.encrypt(account.accessToken);
        await tx.socialAccount.upsert({
          where: {
            clientId_platform_externalAccountId: {
              clientId: context.clientId,
              platform: account.platform,
              externalAccountId: account.externalAccountId,
            },
          },
          create: {
            clientId: context.clientId,
            platformConnectionId: saved.id,
            platform: account.platform,
            displayName: account.displayName,
            externalAccountId: account.externalAccountId,
            accountType: account.accountType,
            username: account.username,
            metadata: account.metadata as Prisma.InputJsonValue,
            providerCapabilities: account.capabilities as Prisma.InputJsonValue,
            isSelected: false,
            ...accountTokenData(accountSecret, account.accessTokenExpiresAt || tokenSet.accessTokenExpiresAt),
            publishCapability: CapabilityStatus.UNVERIFIED,
            metricsCapability: CapabilityStatus.UNVERIFIED,
            commentsCapability: CapabilityStatus.UNVERIFIED,
            messagesCapability: CapabilityStatus.UNSUPPORTED,
            groupsCapability: CapabilityStatus.UNSUPPORTED,
          },
          update: {
            platformConnectionId: saved.id,
            displayName: account.displayName,
            accountType: account.accountType,
            username: account.username,
            metadata: account.metadata as Prisma.InputJsonValue,
            providerCapabilities: account.capabilities as Prisma.InputJsonValue,
            isSelected: false,
            ...accountTokenData(accountSecret, account.accessTokenExpiresAt || tokenSet.accessTokenExpiresAt),
            publishCapability: CapabilityStatus.UNVERIFIED,
            metricsCapability: CapabilityStatus.UNVERIFIED,
            commentsCapability: CapabilityStatus.UNVERIFIED,
            messagesCapability: CapabilityStatus.UNSUPPORTED,
            groupsCapability: CapabilityStatus.UNSUPPORTED,
            verifiedAt: null,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          clientId: context.clientId,
          userId: context.userId,
          action: "PLATFORM_OAUTH_COMPLETED",
          entityType: "PlatformConnection",
          entityId: saved.id,
          metadata: { provider, discoveredAccountCount: discovery.accounts.length, scopeCount: discovery.grantedScopes.length },
        },
      });
      return saved;
    });
    return { connectionId: connection.id, returnTo: stateRecord.returnTo || "/connections" };
  } catch (error) {
    const normalized = normalizeAuthFailure(error);
    await db.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "PLATFORM_OAUTH_FAILED",
        entityType: "OAuthState",
        entityId: stateRecord.id,
        metadata: { provider, errorCode: normalized.code },
      },
    });
    throw new AppError(normalized.message, normalized.status, normalized.code);
  }
}

export async function selectPlatformAccounts(context: RequestContext, connectionId: string, accountIds: string[]) {
  assertOwner(context);
  const uniqueIds = [...new Set(accountIds)];
  if (!uniqueIds.length) throw new AppError("至少选择一个账号。", 400, "ACCOUNT_SELECTION_REQUIRED");
  const connection = await requireScopedConnection(context, connectionId);
  const accounts = await db.socialAccount.findMany({
    where: { id: { in: uniqueIds }, clientId: context.clientId, platformConnectionId: connection.id },
  });
  if (accounts.length !== uniqueIds.length) throw new AppError("包含不存在或其他客户的账号。", 403, "ACCOUNT_SCOPE_VIOLATION");

  await db.$transaction(async (tx) => {
    await tx.socialAccount.updateMany({
      where: { clientId: context.clientId, platformConnectionId: connection.id, id: { notIn: uniqueIds } },
      data: {
        isSelected: false,
        publishCapability: CapabilityStatus.UNVERIFIED,
        metricsCapability: CapabilityStatus.UNVERIFIED,
        commentsCapability: CapabilityStatus.UNVERIFIED,
      },
    });
    for (const account of accounts) {
      const capabilities = (account.providerCapabilities || {}) as Record<string, unknown>;
      const facebook = account.accountType === "FACEBOOK_PAGE";
      await tx.socialAccount.update({
        where: { id: account.id },
        data: {
          isSelected: true,
          publishCapability: facebook && capabilities.canPublish === true ? CapabilityStatus.VERIFIED : CapabilityStatus.UNSUPPORTED,
          metricsCapability: facebook && capabilities.canReadMetrics === true ? CapabilityStatus.VERIFIED : CapabilityStatus.UNVERIFIED,
          commentsCapability: facebook && capabilities.canReadComments === true ? CapabilityStatus.VERIFIED : CapabilityStatus.UNVERIFIED,
          verifiedAt: facebook && capabilities.canPublish === true ? new Date() : null,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "PLATFORM_ACCOUNTS_SELECTED",
        entityType: "PlatformConnection",
        entityId: connection.id,
        metadata: { provider: connection.provider, accountIds: uniqueIds },
      },
    });
  });
  return listScopedConnection(context, connection.id);
}

export async function disconnectPlatformConnection(
  context: RequestContext,
  connectionId: string,
  overrides: { adapter?: PlatformAuthAdapter; vault?: TokenVault } = {},
) {
  assertOwner(context);
  const connection = await requireScopedConnection(context, connectionId);
  let revokeWarning: string | null = null;
  if (connection.accessTokenCiphertext && connection.accessTokenIv && connection.accessTokenAuthTag) {
    try {
      const vault = overrides.vault || TokenVault.fromEnvironment();
      const token = vault.decrypt({
        ciphertext: connection.accessTokenCiphertext,
        iv: connection.accessTokenIv,
        authTag: connection.accessTokenAuthTag,
        keyVersion: connection.tokenKeyVersion,
      });
      const adapter = overrides.adapter || getAuthAdapter(connection.provider);
      if (adapter.revoke) await adapter.revoke(token);
    } catch (error) {
      revokeWarning = normalizeAuthFailure(error).code;
    }
  }
  await db.$transaction([
    db.platformConnection.update({
      where: { id: connection.id },
      data: {
        status: "DISCONNECTED",
        accessTokenCiphertext: null,
        accessTokenIv: null,
        accessTokenAuthTag: null,
        refreshTokenCiphertext: null,
        refreshTokenIv: null,
        refreshTokenAuthTag: null,
        lastErrorCode: revokeWarning,
        lastErrorMessage: revokeWarning ? "远端撤销未确认；本地凭据已清除。" : null,
      },
    }),
    db.socialAccount.updateMany({
      where: { clientId: context.clientId, platformConnectionId: connection.id },
      data: {
        isSelected: false,
        accessTokenCiphertext: null,
        accessTokenIv: null,
        accessTokenAuthTag: null,
        publishCapability: CapabilityStatus.UNVERIFIED,
        metricsCapability: CapabilityStatus.UNVERIFIED,
        commentsCapability: CapabilityStatus.UNVERIFIED,
        verifiedAt: null,
      },
    }),
    db.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "PLATFORM_CONNECTION_DISCONNECTED",
        entityType: "PlatformConnection",
        entityId: connection.id,
        metadata: { provider: connection.provider, remoteRevokeConfirmed: revokeWarning === null },
      },
    }),
  ]);
  return { disconnected: true, remoteRevokeConfirmed: revokeWarning === null };
}

export async function refreshPlatformConnection(
  context: RequestContext,
  connectionId: string,
  overrides: { adapter?: PlatformAuthAdapter; vault?: TokenVault } = {},
) {
  assertOwner(context);
  const connection = await requireScopedConnection(context, connectionId);
  const adapter = overrides.adapter || getAuthAdapter(connection.provider);
  if (!adapter.refresh || !connection.refreshTokenCiphertext || !connection.refreshTokenIv || !connection.refreshTokenAuthTag) {
    throw new AppError("当前 provider 不支持 refresh token；请重新连接。", 409, "TOKEN_REFRESH_UNSUPPORTED");
  }
  const vault = overrides.vault || TokenVault.fromEnvironment();
  const refreshToken = vault.decrypt({
    ciphertext: connection.refreshTokenCiphertext,
    iv: connection.refreshTokenIv,
    authTag: connection.refreshTokenAuthTag,
    keyVersion: connection.tokenKeyVersion,
  });
  const tokenSet = await adapter.refresh(refreshToken);
  const accessSecret = vault.encrypt(tokenSet.accessToken);
  const refreshSecret = tokenSet.refreshToken ? vault.encrypt(tokenSet.refreshToken) : null;
  await db.platformConnection.update({
    where: { id: connection.id },
    data: {
      ...connectionTokenData(accessSecret, refreshSecret),
      accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
      scopes: tokenSet.scopes,
      status: "CONNECTED",
      lastRefreshedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  return listScopedConnection(context, connection.id);
}

export async function listPlatformConnections(context: RequestContext) {
  return db.platformConnection.findMany({
    where: { clientId: context.clientId },
    select: publicConnectionSelect,
    orderBy: { updatedAt: "desc" },
  });
}

export async function listPlatformConnectionAccounts(context: RequestContext, connectionId: string) {
  const connection = await listScopedConnection(context, connectionId);
  return connection.accounts;
}

async function listScopedConnection(context: RequestContext, connectionId: string) {
  return db.platformConnection.findFirstOrThrow({
    where: { id: connectionId, clientId: context.clientId },
    select: publicConnectionSelect,
  });
}

async function requireScopedConnection(context: RequestContext, connectionId: string) {
  const connection = await db.platformConnection.findFirst({ where: { id: connectionId, clientId: context.clientId } });
  if (!connection) throw new AppError("平台连接不存在或无权访问。", 404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

function getAuthAdapter(provider: Provider): PlatformAuthAdapter {
  if (provider === "META") return createMetaAuthAdapter();
  throw new AppError(`${provider} 真实连接尚未实现。`, 409, "AUTH_ADAPTER_NOT_IMPLEMENTED");
}

function configuredRedirectUri(provider: Provider) {
  if (provider === "META" && process.env.META_REDIRECT_URI) return process.env.META_REDIRECT_URI;
  throw new AppError(`${provider} redirect URI 未配置。`, 503, "OAUTH_REDIRECT_URI_NOT_CONFIGURED");
}

function normalizeReturnTo(returnTo: string) {
  return returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/connections";
}

function connectionTokenData(access: EncryptedSecret, refresh: EncryptedSecret | null) {
  return {
    accessTokenCiphertext: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    refreshTokenCiphertext: refresh?.ciphertext || null,
    refreshTokenIv: refresh?.iv || null,
    refreshTokenAuthTag: refresh?.authTag || null,
    tokenKeyVersion: access.keyVersion,
  };
}

function accountTokenData(access: EncryptedSecret, expiresAt?: Date) {
  return {
    accessTokenCiphertext: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    accessTokenExpiresAt: expiresAt,
  };
}

function normalizeAuthFailure(error: unknown) {
  if (error instanceof PlatformAuthError) return { code: error.code, message: safeErrorMessage(error), status: error.status };
  if (error instanceof AppError) return { code: error.code, message: safeErrorMessage(error), status: error.status };
  return { code: "PLATFORM_AUTH_FAILED", message: safeErrorMessage(error), status: 502 };
}

const publicConnectionSelect = {
  id: true,
  clientId: true,
  provider: true,
  externalPrincipalId: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
  scopes: true,
  status: true,
  connectedAt: true,
  lastRefreshedAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
  accounts: {
    select: {
      id: true,
      platform: true,
      displayName: true,
      externalAccountId: true,
      accountType: true,
      username: true,
      metadata: true,
      providerCapabilities: true,
      isSelected: true,
      publishCapability: true,
      metricsCapability: true,
      commentsCapability: true,
      messagesCapability: true,
      groupsCapability: true,
      verifiedAt: true,
    },
    orderBy: [{ isSelected: "desc" as const }, { platform: "asc" as const }, { displayName: "asc" as const }],
  },
} satisfies Prisma.PlatformConnectionSelect;
