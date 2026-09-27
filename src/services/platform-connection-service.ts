import { randomBytes } from "node:crypto";
import { CapabilityStatus, Prisma, PublishJobStatus, type Provider } from "@prisma/client";
import { createMetaAuthAdapter, REQUIRED_META_CONNECTION_SCOPES } from "../lib/adapters/meta-auth";
import { PlatformAuthError, type PlatformAuthAdapter } from "../lib/adapters/platform-auth";
import { assertOwner, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { sha256 } from "../lib/security";
import { safeErrorMessage, TokenVault, type EncryptedSecret } from "../lib/token-vault";
import { getPlatformRegistry } from "./platform-registry-service";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DESTRUCTIVE_CHANGE_BLOCKED_API_JOB_STATUSES: PublishJobStatus[] = [
  PublishJobStatus.PENDING,
  PublishJobStatus.RETRY,
  PublishJobStatus.WAITING_CONFIGURATION,
  PublishJobStatus.RUNNING,
  PublishJobStatus.UNKNOWN,
];
const REAUTHORIZATION_BLOCKED_API_JOB_STATUSES: PublishJobStatus[] = [
  PublishJobStatus.PENDING,
  PublishJobStatus.RETRY,
  PublishJobStatus.RUNNING,
  PublishJobStatus.UNKNOWN,
];

export function normalizeAccountIdSet(values: string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean))].sort();
}

async function lockClient(tx: Prisma.TransactionClient, clientId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Client" WHERE "id" = ${clientId} FOR UPDATE
  `;
  if (!rows.length) throw new AppError("客户不存在或无权访问。", 404, "CLIENT_NOT_FOUND");
}

async function lockConnection(tx: Prisma.TransactionClient, clientId: string, connectionId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PlatformConnection"
    WHERE "id" = ${connectionId} AND "clientId" = ${clientId} FOR UPDATE
  `;
  if (!rows.length) throw new AppError("平台连接不存在或无权访问。", 404, "PLATFORM_CONNECTION_NOT_FOUND");
  return tx.platformConnection.findUniqueOrThrow({ where: { id: connectionId } });
}

async function lockAccountIds(tx: Prisma.TransactionClient, clientId: string, ids: string[]) {
  if (!ids.length) return;
  await tx.$queryRaw`
    SELECT "id" FROM "SocialAccount"
    WHERE "clientId" = ${clientId} AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id" FOR UPDATE
  `;
}

async function assertNoActiveApiJobs(
  tx: Prisma.TransactionClient,
  clientId: string,
  accountIds: string[],
  statuses = DESTRUCTIVE_CHANGE_BLOCKED_API_JOB_STATUSES,
) {
  if (!accountIds.length) return;
  const blocked = await tx.publishJob.findFirst({
    where: {
      clientId,
      accountId: { in: accountIds },
      adapter: { not: "manual" },
      environment: "LIVE",
      simulated: false,
      status: { in: statuses },
    },
    select: { status: true },
  });
  if (blocked) {
    throw new AppError(
      `受影响账号仍有 ${blocked.status} API 发布任务。请先在发布中心处理现有任务，再修改账号连接或选择。`,
      409,
      "ACCOUNT_ACTIVE_PUBLISH_JOBS",
    );
  }
}

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
      await lockClient(tx, context.clientId);
      const existing = await tx.platformConnection.findUnique({
        where: {
          clientId_provider_externalPrincipalId: {
            clientId: context.clientId,
            provider,
            externalPrincipalId: discovery.externalPrincipalId,
          },
        },
      });
      if (existing) await lockConnection(tx, context.clientId, existing.id);
      const affectedAccounts = await tx.socialAccount.findMany({
        where: {
          clientId: context.clientId,
          OR: [
            ...(existing ? [{ platformConnectionId: existing.id }] : []),
            ...discovery.accounts.map((account) => ({ platform: account.platform, externalAccountId: account.externalAccountId })),
          ],
        },
        select: {
          id: true, platform: true, externalAccountId: true, isSelected: true,
          publishCapability: true, metricsCapability: true, commentsCapability: true,
        },
      });
      await lockAccountIds(tx, context.clientId, affectedAccounts.map((account) => account.id));
      await assertNoActiveApiJobs(tx, context.clientId, affectedAccounts.map((account) => account.id), REAUTHORIZATION_BLOCKED_API_JOB_STATUSES);
      const waitingJobs = await tx.publishJob.findMany({
        where: {
          clientId: context.clientId,
          accountId: { in: affectedAccounts.map((account) => account.id) },
          adapter: { not: "manual" }, environment: "LIVE", simulated: false,
          status: PublishJobStatus.WAITING_CONFIGURATION,
        },
        select: { accountId: true },
      });
      const waitingAccountIds = new Set(waitingJobs.map((job) => job.accountId));
      const missingScopes = REQUIRED_META_CONNECTION_SCOPES.filter(
        (scope) => !discovery.grantedScopes.includes(scope),
      );
      const accountIdentity = (platform: string, externalAccountId: string) => `${platform}\u0000${externalAccountId}`;
      const discoveredByIdentity = new Map(discovery.accounts.map((account) => [
        accountIdentity(account.platform, account.externalAccountId), account,
      ]));
      const existingByIdentity = new Map(affectedAccounts.filter((account) => account.externalAccountId).map((account) => [
        accountIdentity(account.platform, account.externalAccountId!), account,
      ]));
      const restoredWaitingCapabilities = new Map<string, ReturnType<typeof selectedCapabilityData>>();
      // Reauthorization may repair a waiting job, but it must not erase or
      // downgrade the account to which that job is already bound.
      for (const account of affectedAccounts.filter((entry) => waitingAccountIds.has(entry.id))) {
        const discovered = account.externalAccountId
          ? discoveredByIdentity.get(accountIdentity(account.platform, account.externalAccountId)) : undefined;
        if (!discovered || missingScopes.length || !discovered.accessToken) {
          throw new AppError("重新授权未能恢复等待中的发布账号及必要权限；请先核对 Meta 账号和授权，现有任务保持不变。", 409, "ACCOUNT_ACTIVE_PUBLISH_JOBS");
        }
        const restored = selectedCapabilityData(provider, {
          platform: discovered.platform,
          providerCapabilities: discovered.capabilities as Prisma.JsonValue,
        });
        if ([
          [account.publishCapability, restored.publishCapability],
          [account.metricsCapability, restored.metricsCapability],
          [account.commentsCapability, restored.commentsCapability],
        ].some(([current, next]) =>
          (current === CapabilityStatus.VERIFIED && next !== CapabilityStatus.VERIFIED)
          || (current !== CapabilityStatus.UNSUPPORTED && next === CapabilityStatus.UNSUPPORTED))) {
          throw new AppError("重新授权会降低等待中账号的能力；请先核对 Meta 权限，现有任务保持不变。", 409, "ACCOUNT_ACTIVE_PUBLISH_JOBS");
        }
        restoredWaitingCapabilities.set(account.id, restored);
      }
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
        const existingAccount = existingByIdentity.get(accountIdentity(account.platform, account.externalAccountId));
        const waitingAccount = existingAccount && waitingAccountIds.has(existingAccount.id) ? existingAccount : null;
        const restored = waitingAccount?.isSelected ? restoredWaitingCapabilities.get(waitingAccount.id) : null;
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
            isSelected: waitingAccount?.isSelected ?? false,
            ...accountTokenData(accountSecret, account.accessTokenExpiresAt || tokenSet.accessTokenExpiresAt),
            ...(waitingAccount
              ? restored ?? {}
              : {
                publishCapability: CapabilityStatus.UNVERIFIED,
                metricsCapability: CapabilityStatus.UNVERIFIED,
                commentsCapability: CapabilityStatus.UNVERIFIED,
                messagesCapability: CapabilityStatus.UNSUPPORTED,
                groupsCapability: CapabilityStatus.UNSUPPORTED,
                verifiedAt: null,
              }),
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

export async function selectPlatformAccounts(
  context: RequestContext,
  connectionId: string,
  accountIds: string[],
  expectedSelectedAccountIds: string[],
) {
  assertOwner(context);
  const uniqueIds = normalizeAccountIdSet(accountIds);
  if (!uniqueIds.length) throw new AppError("至少选择一个账号。", 400, "ACCOUNT_SELECTION_REQUIRED");
  await db.$transaction(async (tx) => {
    await lockClient(tx, context.clientId);
    const connection = await lockConnection(tx, context.clientId, connectionId);
    if (connection.status !== "CONNECTED") {
      throw new AppError("平台连接当前不可用，请重新连接后再选择账号。", 409, "PLATFORM_CONNECTION_NOT_READY");
    }
    const accounts = await tx.socialAccount.findMany({
      where: { clientId: context.clientId, platformConnectionId: connection.id },
      orderBy: { id: "asc" },
    });
    await lockAccountIds(tx, context.clientId, accounts.map((account) => account.id));
    const currentSelected = normalizeAccountIdSet(accounts.filter((account) => account.isSelected).map((account) => account.id));
    if (currentSelected.join("\u0000") !== normalizeAccountIdSet(expectedSelectedAccountIds).join("\u0000")) {
      throw new AppError("账号选择已被其他人更新，请刷新页面后重试。", 409, "ACCOUNT_SELECTION_CONFLICT");
    }
    if (uniqueIds.some((id) => !accounts.some((account) => account.id === id))) {
      throw new AppError("包含不存在或其他客户的账号。", 403, "ACCOUNT_SCOPE_VIOLATION");
    }
    const selectedSet = new Set(uniqueIds);
    const affectedIds = accounts.filter((account) => {
      if (!selectedSet.has(account.id)) return account.isSelected
        || account.publishCapability !== CapabilityStatus.UNVERIFIED
        || account.metricsCapability !== CapabilityStatus.UNVERIFIED
        || account.commentsCapability !== CapabilityStatus.UNVERIFIED;
      const capability = selectedCapabilityData(connection.provider, account);
      return (account.publishCapability === CapabilityStatus.VERIFIED && capability.publishCapability !== CapabilityStatus.VERIFIED)
        || (account.metricsCapability === CapabilityStatus.VERIFIED && capability.metricsCapability !== CapabilityStatus.VERIFIED)
        || (account.commentsCapability === CapabilityStatus.VERIFIED && capability.commentsCapability !== CapabilityStatus.VERIFIED);
    }).map((account) => account.id);
    await assertNoActiveApiJobs(tx, context.clientId, affectedIds);
    await tx.socialAccount.updateMany({
      where: { clientId: context.clientId, platformConnectionId: connection.id, id: { notIn: uniqueIds } },
      data: {
        isSelected: false,
        publishCapability: CapabilityStatus.UNVERIFIED,
        metricsCapability: CapabilityStatus.UNVERIFIED,
        commentsCapability: CapabilityStatus.UNVERIFIED,
      },
    });
    for (const account of accounts.filter((account) => selectedSet.has(account.id))) {
      await tx.socialAccount.update({
        where: { id: account.id },
        data: {
          isSelected: true,
          ...selectedCapabilityData(connection.provider, account),
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
  return listScopedConnection(context, connectionId);
}

function selectedCapabilityData(provider: Provider, account: { platform: string; providerCapabilities: Prisma.JsonValue | null }) {
  const capabilities = (account.providerCapabilities || {}) as Record<string, unknown>;
  const definition = getPlatformRegistry().get(provider, account.platform).definition;
  const publishingImplemented = definition.capabilities.includes("PUBLISH");
  const metricsImplemented = definition.capabilities.includes("METRICS");
  const commentsImplemented = definition.capabilities.includes("COMMENTS");
  const publishVerified = publishingImplemented && capabilities.canPublish === true;
  return {
    publishCapability: publishVerified ? CapabilityStatus.VERIFIED : publishingImplemented ? CapabilityStatus.UNVERIFIED : CapabilityStatus.UNSUPPORTED,
    metricsCapability: metricsImplemented ? capabilities.canReadMetrics === true ? CapabilityStatus.VERIFIED : CapabilityStatus.UNVERIFIED : CapabilityStatus.UNSUPPORTED,
    commentsCapability: commentsImplemented ? capabilities.canReadComments === true ? CapabilityStatus.VERIFIED : CapabilityStatus.UNVERIFIED : CapabilityStatus.UNSUPPORTED,
    verifiedAt: publishVerified ? new Date() : null,
  };
}

export async function disconnectPlatformConnection(
  context: RequestContext,
  connectionId: string,
  overrides: { adapter?: PlatformAuthAdapter; vault?: TokenVault } = {},
) {
  assertOwner(context);
  const connection = await db.$transaction(async (tx) => {
    await lockClient(tx, context.clientId);
    const scoped = await lockConnection(tx, context.clientId, connectionId);
    const accounts = await tx.socialAccount.findMany({
      where: { clientId: context.clientId, platformConnectionId: connectionId },
      select: { id: true },
    });
    await lockAccountIds(tx, context.clientId, accounts.map((account) => account.id));
    await assertNoActiveApiJobs(tx, context.clientId, accounts.map((account) => account.id));
    await tx.platformConnection.update({
      where: { id: scoped.id },
      data: {
        status: "DISCONNECTED",
        accessTokenCiphertext: null,
        accessTokenIv: null,
        accessTokenAuthTag: null,
        refreshTokenCiphertext: null,
        refreshTokenIv: null,
        refreshTokenAuthTag: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    await tx.socialAccount.updateMany({
      where: { clientId: context.clientId, platformConnectionId: scoped.id },
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
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "PLATFORM_CONNECTION_DISCONNECTED",
        entityType: "PlatformConnection",
        entityId: scoped.id,
        metadata: { provider: scoped.provider, localCredentialsCleared: true },
      },
    });
    return scoped;
  });

  const hasRevokeToken = Boolean(connection.accessTokenCiphertext && connection.accessTokenIv && connection.accessTokenAuthTag);
  let revokeAttempted = false;
  let revokeWarning: string | null = hasRevokeToken ? null : "REMOTE_REVOKE_NOT_ATTEMPTED";
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
      if (!adapter.revoke) throw new AppError("该平台适配器不支持远端撤销；本地凭据已清除。", 409, "REMOTE_REVOKE_UNSUPPORTED");
      revokeAttempted = true;
      await adapter.revoke(token);
    } catch (error) {
      revokeWarning = normalizeAuthFailure(error).code;
    }
  }
  const remoteRevokeConfirmed = revokeAttempted && revokeWarning === null;
  try {
    await db.$transaction(async (tx) => {
      if (revokeWarning) {
        await tx.platformConnection.updateMany({
          where: { id: connection.id, clientId: context.clientId, status: "DISCONNECTED" },
          data: { lastErrorCode: revokeWarning, lastErrorMessage: revokeAttempted ? "远端撤销未确认；本地凭据已清除。" : "远端撤销未执行；本地凭据已清除。" },
        });
      }
      await tx.auditLog.create({
        data: {
          clientId: context.clientId,
          userId: context.userId,
          action: "PLATFORM_REMOTE_REVOKE_RESULT",
          entityType: "PlatformConnection",
          entityId: connection.id,
          metadata: { provider: connection.provider, revokeAttempted, remoteRevokeConfirmed, warningCode: revokeWarning },
        },
      });
    });
  } catch {
    console.warn("Could not persist platform remote revoke result audit", connection.id);
  }
  return { disconnected: true, revokeAttempted, remoteRevokeConfirmed };
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
