import {
  CapabilityStatus,
  ContentStatus,
  DataAvailability,
  FacebookTokenStatus,
  PublishJobStatus,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";
import { FacebookGraphAdapter, FacebookGraphError, FACEBOOK_ERROR_ADVICE, type FacebookErrorCategory } from "../lib/adapters/facebook-graph";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { maskSecret, resolveFacebookSecret } from "../lib/secrets";
import { importInteraction } from "./interaction-service";

const defaultPermissions = ["pages_manage_posts", "pages_read_engagement", "pages_read_user_content"];
const connectionInput = z.object({
  accountId: z.string().min(1),
  pageId: z.string().regex(/^\d+$/, "Page ID 必须是数字。"),
  graphApiVersion: z.string().regex(/^v\d+\.\d+$/, "Graph API 版本格式应为 v26.0。"),
  credentialRef: z.string().regex(/^env:FACEBOOK_[A-Z0-9_]+$/, "凭据引用必须使用 env:FACEBOOK_...。"),
  requiredPermissions: z.array(z.string().min(1)).default(defaultPermissions),
  metricKeys: z.array(z.string().regex(/^[a-z0-9_]+$/)).default([]),
});

export async function configureFacebookPage(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = connectionInput.parse(raw);
  const requiredPermissions = [...new Set([...defaultPermissions, ...input.requiredPermissions])];
  const account = await db.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId, platform: "facebook" } });
  if (!account) throw new AppError("Facebook 账号不存在或无权访问。", 404, "FACEBOOK_ACCOUNT_NOT_FOUND");
  return db.$transaction(async (tx) => {
    const connection = await tx.facebookPageConnection.upsert({
      where: { accountId: account.id },
      create: {
        clientId: context.clientId,
        accountId: account.id,
        pageId: input.pageId,
        graphApiVersion: input.graphApiVersion,
        credentialRef: input.credentialRef,
        requiredPermissions,
        metricKeys: input.metricKeys,
      },
      update: {
        pageId: input.pageId,
        graphApiVersion: input.graphApiVersion,
        credentialRef: input.credentialRef,
        requiredPermissions,
        metricKeys: input.metricKeys,
        connectionStatus: CapabilityStatus.UNVERIFIED,
        tokenStatus: FacebookTokenStatus.UNVERIFIED,
        verifiedAt: null,
        lastErrorCategory: null,
        lastErrorMessage: null,
      },
    });
    await tx.socialAccount.update({
      where: { id: account.id },
      data: {
        externalAccountId: input.pageId,
        credentialRef: input.credentialRef,
        publishCapability: CapabilityStatus.UNVERIFIED,
        metricsCapability: CapabilityStatus.UNVERIFIED,
        commentsCapability: CapabilityStatus.UNVERIFIED,
        messagesCapability: CapabilityStatus.UNSUPPORTED,
        groupsCapability: CapabilityStatus.UNSUPPORTED,
        verifiedAt: null,
      },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "FACEBOOK_PAGE_CONFIGURED",
        entityType: "FacebookPageConnection",
        entityId: connection.id,
        metadata: { pageId: input.pageId, graphApiVersion: input.graphApiVersion, credentialReferenceConfigured: true },
      },
    });
    return connection;
  });
}

export async function validateFacebookPage(context: RequestContext, accountId: string, adapterOverride?: FacebookGraphAdapter) {
  assertCanWrite(context);
  const connection = await getScopedConnection(context.clientId, accountId);
  let token = "";
  try {
    token = adapterOverride ? "" : resolveFacebookSecret(connection.credentialRef);
    const adapter = adapterOverride || createAdapter(connection.pageId, token, connection.graphApiVersion);
    const probe = await adapter.validateConnection();
    const missingPermissions = connection.requiredPermissions.filter((permission) => !probe.grantedPermissions.includes(permission));
    const canPublish = probe.pageTasks.includes("CREATE_CONTENT");
    if (!canPublish || missingPermissions.length) {
      const details = [!canPublish ? "Page 任务缺少 CREATE_CONTENT" : null, missingPermissions.length ? `缺少权限：${missingPermissions.join(", ")}` : null].filter(Boolean).join("；");
      throw new FacebookGraphError("PERMISSION_DENIED", details, false);
    }
    const now = new Date();
    return db.$transaction(async (tx) => {
      const updated = await tx.facebookPageConnection.update({
        where: { id: connection.id },
        data: {
          pageName: probe.pageName,
          pageTasks: probe.pageTasks,
          grantedPermissions: probe.grantedPermissions,
          tokenStatus: FacebookTokenStatus.VALID,
          connectionStatus: CapabilityStatus.VERIFIED,
          verifiedAt: now,
          lastCheckedAt: now,
          lastErrorCategory: null,
          lastErrorMessage: null,
        },
      });
      await tx.socialAccount.update({
        where: { id: connection.accountId },
        data: {
          displayName: probe.pageName,
          externalAccountId: probe.pageId,
          publishCapability: CapabilityStatus.VERIFIED,
          metricsCapability: probe.pageTasks.includes("ANALYZE") ? CapabilityStatus.VERIFIED : CapabilityStatus.UNVERIFIED,
          commentsCapability: probe.pageTasks.includes("MODERATE") ? CapabilityStatus.VERIFIED : CapabilityStatus.UNVERIFIED,
          verifiedAt: now,
        },
      });
      await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "FACEBOOK_PAGE_VERIFIED", entityType: "FacebookPageConnection", entityId: connection.id, metadata: { pageId: probe.pageId, permissionCount: probe.grantedPermissions.length, pageTasks: probe.pageTasks } } });
      return updated;
    });
  } catch (error) {
    const normalized = normalizeFacebookFailure(error, token);
    const tokenStatus = normalized.category === "TOKEN_INVALID" ? FacebookTokenStatus.EXPIRED : normalized.category === "PERMISSION_DENIED" ? FacebookTokenStatus.VALID : FacebookTokenStatus.UNKNOWN;
    await db.$transaction([
      db.facebookPageConnection.update({ where: { id: connection.id }, data: { connectionStatus: CapabilityStatus.UNVERIFIED, tokenStatus, lastCheckedAt: new Date(), lastErrorCategory: normalized.category, lastErrorMessage: normalized.message } }),
      db.socialAccount.update({ where: { id: connection.accountId }, data: { publishCapability: CapabilityStatus.UNVERIFIED, metricsCapability: CapabilityStatus.UNVERIFIED, commentsCapability: CapabilityStatus.UNVERIFIED, verifiedAt: null } }),
    ]);
    throw new AppError(`${normalized.message} 处理建议：${FACEBOOK_ERROR_ADVICE[normalized.category]}`, 409, normalized.category);
  }
}

export async function syncFacebookMetrics(context: RequestContext, accountId: string, adapterOverride?: FacebookGraphAdapter) {
  assertCanWrite(context);
  const connection = await requireVerifiedConnection(context.clientId, accountId);
  if (!connection.metricKeys.length) throw new AppError("请先配置至少一个经 Meta 文档或接口验证的指标名称。", 409, "FACEBOOK_METRICS_NOT_CONFIGURED");
  const token = adapterOverride ? "" : resolveFacebookSecret(connection.credentialRef);
  const adapter = adapterOverride || createAdapter(connection.pageId, token, connection.graphApiVersion);
  const snapshots = [];
  for (const metricKey of connection.metricKeys) {
    const fetchedAt = new Date();
    try {
      const values = await adapter.readMetrics([metricKey]);
      const value = values.find((candidate) => candidate.metricKey === metricKey);
      snapshots.push(await db.metricSnapshot.create({
        data: value
          ? { clientId: context.clientId, accountId, metricKey, numericValue: value.value, availability: DataAvailability.AVAILABLE, dataKind: "REAL", periodStart: value.periodStart, periodEnd: value.periodEnd, fetchedAt, source: `facebook-graph:${connection.graphApiVersion}` }
          : { clientId: context.clientId, accountId, metricKey, numericValue: null, availability: DataAvailability.UNSUPPORTED, dataKind: "REAL", fetchedAt, source: `facebook-graph:${connection.graphApiVersion}`, errorMessage: "接口未返回该指标；可能不适用于此 Page 或已弃用。" },
      }));
    } catch (error) {
      const normalized = normalizeFacebookFailure(error, token);
      snapshots.push(await db.metricSnapshot.create({ data: { clientId: context.clientId, accountId, metricKey, numericValue: null, availability: normalized.category === "PERMISSION_DENIED" || normalized.category === "TOKEN_INVALID" ? DataAvailability.PERMISSION_DENIED : DataAvailability.READ_FAILED, dataKind: "REAL", fetchedAt, source: `facebook-graph:${connection.graphApiVersion}`, errorMessage: `${normalized.category}: ${normalized.message}` } }));
      if (normalized.category === "TOKEN_INVALID") await markConnectionInvalid(connection.id, accountId, normalized);
    }
  }
  await db.facebookPageConnection.update({ where: { id: connection.id }, data: { metricsSyncedAt: new Date() } });
  return snapshots;
}

export async function syncFacebookComments(context: RequestContext, publishJobId: string, adapterOverride?: FacebookGraphAdapter) {
  assertCanWrite(context);
  const job = await db.publishJob.findFirst({ where: { id: publishJobId, clientId: context.clientId }, include: { account: { include: { facebookConnection: true } } } });
  if (!job || job.account.clientId !== context.clientId) throw new AppError("发布任务不存在或无权访问。", 404, "PUBLISH_JOB_NOT_FOUND");
  if (job.environment !== "LIVE" || job.adapter !== "facebook-graph" || !job.remotePostId) throw new AppError("只有已保存远端 ID 的 Facebook LIVE 帖子可同步评论。", 409, "FACEBOOK_POST_NOT_QUERYABLE");
  const connection = job.account.facebookConnection;
  if (!connection || connection.connectionStatus !== CapabilityStatus.VERIFIED || job.account.commentsCapability !== CapabilityStatus.VERIFIED) throw new AppError("Facebook 评论读取能力尚未验证。", 409, "FACEBOOK_COMMENTS_UNVERIFIED");
  const token = adapterOverride ? "" : resolveFacebookSecret(connection.credentialRef);
  const adapter = adapterOverride || createAdapter(connection.pageId, token, connection.graphApiVersion);
  try {
    const page = await adapter.readComments(job.remotePostId);
    const results = [];
    for (const comment of page.comments) {
      results.push(await importInteraction(context, {
        accountId: job.accountId,
        platform: "facebook",
        platformRecordId: comment.id,
        interactionType: "COMMENT",
        authorHandle: comment.authorId || undefined,
        authorDisplay: comment.authorName || undefined,
        body: comment.message,
        sourceUrl: comment.permalinkUrl || job.remotePostUrl || undefined,
        occurredAt: comment.createdAt,
      }, { source: "facebook-graph", rawPayload: comment.raw }));
    }
    await db.facebookPageConnection.update({ where: { id: connection.id }, data: { commentsSyncedAt: new Date(), commentsCursor: page.nextCursor } });
    return { imported: results.filter((item) => !item.duplicated).length, duplicated: results.filter((item) => item.duplicated).length, nextCursor: page.nextCursor };
  } catch (error) {
    const normalized = normalizeFacebookFailure(error, token);
    if (normalized.category === "TOKEN_INVALID") await markConnectionInvalid(connection.id, job.accountId, normalized);
    throw new AppError(`${normalized.message} 处理建议：${FACEBOOK_ERROR_ADVICE[normalized.category]}`, 409, normalized.category);
  }
}

export async function syncFacebookPostMetrics(context: RequestContext, publishJobId: string, adapterOverride?: FacebookGraphAdapter) {
  assertCanWrite(context);
  const job = await db.publishJob.findFirst({ where: { id: publishJobId, clientId: context.clientId }, include: { account: { include: { facebookConnection: true } } } });
  if (!job || job.account.clientId !== context.clientId) throw new AppError("发布任务不存在或无权访问。", 404, "PUBLISH_JOB_NOT_FOUND");
  if (job.environment !== "LIVE" || job.adapter !== "facebook-graph" || !job.remotePostId) throw new AppError("只有带远端 ID 的 Facebook LIVE 帖子可同步帖子指标。", 409, "FACEBOOK_POST_NOT_QUERYABLE");
  const connection = job.account.facebookConnection;
  if (!connection || connection.connectionStatus !== CapabilityStatus.VERIFIED || job.account.metricsCapability !== CapabilityStatus.VERIFIED) throw new AppError("Facebook 指标能力尚未验证。", 409, "FACEBOOK_METRICS_UNVERIFIED");
  const token = adapterOverride ? "" : resolveFacebookSecret(connection.credentialRef);
  const adapter = adapterOverride || createAdapter(connection.pageId, token, connection.graphApiVersion);
  const fetchedAt = new Date();
  try {
    const values = await adapter.readPostMetrics(job.remotePostId);
    if (!values.length) {
      return [await db.metricSnapshot.create({ data: { clientId: context.clientId, accountId: job.accountId, metricKey: `post_engagement:${job.remotePostId}`, numericValue: null, availability: DataAvailability.UNSUPPORTED, dataKind: "REAL", fetchedAt, source: `facebook-graph:${connection.graphApiVersion}`, errorMessage: "接口未返回评论或回应汇总。" } })];
    }
    return db.$transaction(values.map((value) => db.metricSnapshot.create({ data: { clientId: context.clientId, accountId: job.accountId, metricKey: `${value.metricKey}:${job.remotePostId}`, numericValue: value.value, availability: DataAvailability.AVAILABLE, dataKind: "REAL", fetchedAt, source: `facebook-graph:${connection.graphApiVersion}` } })));
  } catch (error) {
    const normalized = normalizeFacebookFailure(error, token);
    if (normalized.category === "TOKEN_INVALID") await markConnectionInvalid(connection.id, job.accountId, normalized);
    return [await db.metricSnapshot.create({ data: { clientId: context.clientId, accountId: job.accountId, metricKey: `post_engagement:${job.remotePostId}`, numericValue: null, availability: normalized.category === "PERMISSION_DENIED" || normalized.category === "TOKEN_INVALID" ? DataAvailability.PERMISSION_DENIED : DataAvailability.READ_FAILED, dataKind: "REAL", fetchedAt, source: `facebook-graph:${connection.graphApiVersion}`, errorMessage: `${normalized.category}: ${normalized.message}` } })];
  }
}

export async function queryFacebookPublish(context: RequestContext, publishJobId: string, adapterOverride?: FacebookGraphAdapter) {
  assertCanWrite(context);
  const job = await db.publishJob.findFirst({ where: { id: publishJobId, clientId: context.clientId }, include: { account: { include: { facebookConnection: true } }, contentVersion: { select: { contentItemId: true } } } });
  if (!job || job.account.clientId !== context.clientId) throw new AppError("发布任务不存在或无权访问。", 404, "PUBLISH_JOB_NOT_FOUND");
  if (job.environment !== "LIVE" || job.adapter !== "facebook-graph") throw new AppError("此任务不是真实 Facebook 发布。", 409, "NOT_FACEBOOK_LIVE_JOB");
  if (!job.remotePostId) throw new AppError("任务没有远端帖子 ID，无法自动查询；请在 Meta 后台人工对账。", 409, "REMOTE_POST_ID_MISSING");
  const connection = job.account.facebookConnection;
  if (!connection) throw new AppError("Facebook 连接不存在。", 409, "FACEBOOK_CONNECTION_MISSING");
  const token = adapterOverride ? "" : resolveFacebookSecret(connection.credentialRef);
  const adapter = adapterOverride || createAdapter(connection.pageId, token, connection.graphApiVersion);
  const result = await adapter.queryByRemotePostId(job.remotePostId);
  const queriedAt = new Date();
  if (result.status === "published") {
    return db.$transaction(async (tx) => {
      const updated = await tx.publishJob.update({ where: { id: job.id }, data: { status: PublishJobStatus.PUBLISHED, remotePostId: result.remotePostId, remotePostUrl: result.remotePostUrl, publishedAt: result.publishedAt, lastQueriedAt: queriedAt, lastErrorCode: null, lastErrorMessage: null } });
      const item = await tx.contentItem.findUnique({ where: { id: job.contentVersion.contentItemId } });
      if (item?.currentVersionId === job.contentVersionId) await tx.contentItem.update({ where: { id: item.id }, data: { status: ContentStatus.PUBLISHED } });
      await tx.auditLog.create({ data: { clientId: context.clientId, userId: context.userId, action: "FACEBOOK_PUBLISH_QUERIED", entityType: "PublishJob", entityId: job.id, metadata: { outcome: "PUBLISHED", remotePostId: result.remotePostId } } });
      return updated;
    });
  }
  const failure = result.status === "failed" ? result : { code: result.code, message: result.message };
  if (failure.code === "TOKEN_INVALID") await markConnectionInvalid(connection.id, job.accountId, { category: "TOKEN_INVALID", message: failure.message });
  return db.publishJob.update({ where: { id: job.id }, data: { lastQueriedAt: queriedAt, lastErrorCode: failure.code, lastErrorMessage: failure.message } });
}

export async function getFacebookAdapterForJob(clientId: string, accountId: string) {
  const connection = await requireVerifiedConnection(clientId, accountId);
  return createAdapter(connection.pageId, resolveFacebookSecret(connection.credentialRef), connection.graphApiVersion);
}

function createAdapter(pageId: string, accessToken: string, apiVersion: string) {
  return new FacebookGraphAdapter({
    pageId,
    accessToken,
    apiVersion,
    baseUrl: process.env.FACEBOOK_GRAPH_BASE_URL,
    timeoutMs: Number(process.env.FACEBOOK_REQUEST_TIMEOUT_MS || 30_000),
  });
}

async function getScopedConnection(clientId: string, accountId: string) {
  const connection = await db.facebookPageConnection.findFirst({ where: { clientId, accountId }, include: { account: true } });
  if (!connection || connection.account.clientId !== clientId) throw new AppError("Facebook 连接不存在或无权访问。", 404, "FACEBOOK_CONNECTION_NOT_FOUND");
  return connection;
}

async function requireVerifiedConnection(clientId: string, accountId: string) {
  const connection = await getScopedConnection(clientId, accountId);
  if (connection.connectionStatus !== CapabilityStatus.VERIFIED || connection.tokenStatus !== FacebookTokenStatus.VALID || connection.account.publishCapability !== CapabilityStatus.VERIFIED) throw new AppError("Facebook Page 连接或令牌尚未验证。", 409, "FACEBOOK_CONNECTION_UNVERIFIED");
  return connection;
}

function normalizeFacebookFailure(error: unknown, token: string): { category: FacebookErrorCategory; message: string } {
  if (error instanceof FacebookGraphError) return { category: error.category, message: maskSecret(error.message, token) };
  if (error instanceof AppError) return { category: error.code === "CREDENTIAL_NOT_CONFIGURED" ? "TOKEN_INVALID" : "API_ERROR", message: maskSecret(error.message, token) };
  return { category: "API_ERROR", message: "Facebook 集成出现未分类错误。" };
}

async function markConnectionInvalid(connectionId: string, accountId: string, error: { category: FacebookErrorCategory; message: string }) {
  await db.$transaction([
    db.facebookPageConnection.update({ where: { id: connectionId }, data: { connectionStatus: CapabilityStatus.UNVERIFIED, tokenStatus: FacebookTokenStatus.EXPIRED, lastCheckedAt: new Date(), lastErrorCategory: error.category, lastErrorMessage: error.message } }),
    db.socialAccount.update({ where: { id: accountId }, data: { publishCapability: CapabilityStatus.UNVERIFIED, metricsCapability: CapabilityStatus.UNVERIFIED, commentsCapability: CapabilityStatus.UNVERIFIED, verifiedAt: null } }),
  ]);
}
