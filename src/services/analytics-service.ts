import type { AnalyticsFreshnessStatus, DataAvailability, DataKind, MetricSnapshot } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import type { RequestContext } from "../lib/context";
import { AppError } from "../lib/errors";

export const canonicalMetricKeys = [
  "impressions", "reach", "views", "video_views", "watch_time",
  "likes", "comments", "shares", "saves", "engagement", "engagement_rate",
  "followers", "follower_growth", "profile_views", "link_clicks",
] as const;

export type CanonicalMetricKey = typeof canonicalMetricKeys[number];
export type AnalyticsGrain = "day" | "week" | "month";

const aliases: Record<string, CanonicalMetricKey> = {
  post_comments_total: "comments",
  comments_total: "comments",
  post_reactions_total: "likes",
  post_engagement: "engagement",
  reactions: "likes",
  page_impressions: "impressions",
  page_post_engagements: "engagement",
  page_views_total: "profile_views",
  video_views_total: "video_views",
  follower_count: "followers",
  follows: "follower_growth",
  clicks: "link_clicks",
};

export function canonicalizeMetricKey(raw: string): { key: CanonicalMetricKey | null; postId: string | null } {
  const [base, ...rest] = raw.toLocaleLowerCase().split(":");
  const normalized = base.replace(/^(real_|mock_)/, "");
  const direct = canonicalMetricKeys.includes(normalized as CanonicalMetricKey) ? normalized as CanonicalMetricKey : aliases[normalized] || null;
  return { key: direct, postId: rest.length ? rest.join(":") : null };
}

function startOfPeriod(date: Date, grain: AnalyticsGrain) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (grain === "week") result.setUTCDate(result.getUTCDate() - result.getUTCDay());
  if (grain === "month") result.setUTCDate(1);
  return result;
}

export function periodBounds(now: Date, grain: AnalyticsGrain) {
  const currentStart = startOfPeriod(now, grain);
  const currentEnd = new Date(currentStart);
  if (grain === "day") currentEnd.setUTCDate(currentEnd.getUTCDate() + 1);
  if (grain === "week") currentEnd.setUTCDate(currentEnd.getUTCDate() + 7);
  if (grain === "month") currentEnd.setUTCMonth(currentEnd.getUTCMonth() + 1);
  const previousStart = new Date(currentStart);
  if (grain === "day") previousStart.setUTCDate(previousStart.getUTCDate() - 1);
  if (grain === "week") previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  if (grain === "month") previousStart.setUTCMonth(previousStart.getUTCMonth() - 1);
  return { currentStart, currentEnd, previousStart };
}

type SnapshotLike = Pick<MetricSnapshot, "metricKey" | "numericValue" | "availability" | "dataKind" | "fetchedAt" | "periodStart" | "periodEnd" | "accountId"> & {
  account?: { platform: string };
};

type MetricSample = { value: number; fetchedAt: Date; intervalKey: string };

function sumDeduplicatedSamples(samples: MetricSample[]) {
  if (!samples.length) return null;
  const latestByInterval = new Map<string, MetricSample>();
  for (const sample of samples) {
    const current = latestByInterval.get(sample.intervalKey);
    if (!current || current.fetchedAt < sample.fetchedAt) latestByInterval.set(sample.intervalKey, sample);
  }
  return [...latestByInterval.values()].reduce((sum, sample) => sum + sample.value, 0);
}

export function aggregateMetricSnapshots(snapshots: SnapshotLike[], bounds: ReturnType<typeof periodBounds>) {
  const dimensions = new Map<string, {
    key: CanonicalMetricKey;
    postId: string | null;
    accountId: string;
    platform: string;
    current: MetricSample[];
    previous: MetricSample[];
    unavailable: Partial<Record<DataAvailability, number>>;
    kinds: Set<DataKind>;
  }>();
  for (const snapshot of snapshots) {
    const canonical = canonicalizeMetricKey(snapshot.metricKey);
    if (!canonical.key) continue;
    const dimensionKey = `${canonical.key}|${snapshot.accountId}|${canonical.postId || "account"}`;
    const item = dimensions.get(dimensionKey) || {
      key: canonical.key,
      postId: canonical.postId,
      accountId: snapshot.accountId,
      platform: snapshot.account?.platform || "unknown",
      current: [], previous: [], unavailable: {}, kinds: new Set<DataKind>(),
    };
    item.kinds.add(snapshot.dataKind);
    if (snapshot.availability !== "AVAILABLE" || snapshot.numericValue === null) {
      item.unavailable[snapshot.availability] = (item.unavailable[snapshot.availability] || 0) + 1;
    } else {
      const sample = {
        value: Number(snapshot.numericValue),
        fetchedAt: snapshot.fetchedAt,
        intervalKey: snapshot.periodStart || snapshot.periodEnd
          ? `${snapshot.periodStart?.toISOString() || "open"}/${snapshot.periodEnd?.toISOString() || "open"}`
          : "latest-unscoped",
      };
      if (snapshot.fetchedAt >= bounds.currentStart && snapshot.fetchedAt < bounds.currentEnd) item.current.push(sample);
      if (snapshot.fetchedAt >= bounds.previousStart && snapshot.fetchedAt < bounds.currentStart) item.previous.push(sample);
    }
    dimensions.set(dimensionKey, item);
  }
  return [...dimensions.values()].map((item) => {
    const current = sumDeduplicatedSamples(item.current);
    const previous = sumDeduplicatedSamples(item.previous);
    const changePercent = current === null || previous === null || previous === 0 ? null : ((current - previous) / previous) * 100;
    return { ...item, current, previous, changePercent, kinds: [...item.kinds] };
  });
}

export function resolveFreshness(input: { status?: AnalyticsFreshnessStatus | null; latestFetchedAt?: Date | null; now?: Date; staleAfterMs?: number }) {
  if (input.status === "SYNCING") return "syncing" as const;
  if (input.status === "FAILED") return "failed" as const;
  if (!input.latestFetchedAt) return "stale" as const;
  const age = (input.now || new Date()).getTime() - input.latestFetchedAt.getTime();
  return age <= (input.staleAfterMs || 24 * 60 * 60 * 1000) ? "fresh" as const : "stale" as const;
}

async function updateSyncState(
  context: RequestContext,
  accountId: string,
  scope: string,
  status: AnalyticsFreshnessStatus,
  errorMessage?: string,
) {
  const account = await db.socialAccount.findFirst({ where: { id: accountId, clientId: context.clientId }, select: { id: true } });
  if (!account) throw new Error("ANALYTICS_ACCOUNT_SCOPE_VIOLATION");
  const now = new Date();
  return db.analyticsSyncState.upsert({
    where: { clientId_accountId_scope: { clientId: context.clientId, accountId, scope } },
    create: {
      clientId: context.clientId, accountId, scope, status,
      lastStartedAt: status === "SYNCING" ? now : undefined,
      lastSucceededAt: status === "FRESH" ? now : undefined,
      lastFailedAt: status === "FAILED" ? now : undefined,
      errorMessage: errorMessage || null,
    },
    update: {
      status,
      ...(status === "SYNCING" ? { lastStartedAt: now } : {}),
      ...(status === "FRESH" ? { lastSucceededAt: now, errorMessage: null } : {}),
      ...(status === "FAILED" ? { lastFailedAt: now, errorMessage: errorMessage || "Metric synchronization failed" } : {}),
    },
  });
}

export function markAnalyticsSyncStarted(context: RequestContext, accountId: string, scope = "metrics") {
  return updateSyncState(context, accountId, scope, "SYNCING");
}

export function markAnalyticsSyncSucceeded(context: RequestContext, accountId: string, scope = "metrics") {
  return updateSyncState(context, accountId, scope, "FRESH");
}

export function markAnalyticsSyncFailed(context: RequestContext, accountId: string, message: string, scope = "metrics") {
  return updateSyncState(context, accountId, scope, "FAILED", message.slice(0, 1000));
}

export async function getAnalyticsOverview(context: RequestContext, grain: AnalyticsGrain = "week", now = new Date()) {
  const bounds = periodBounds(now, grain);
  const [snapshots, syncStates] = await Promise.all([
    db.metricSnapshot.findMany({
      where: { clientId: context.clientId, fetchedAt: { gte: bounds.previousStart, lt: bounds.currentEnd } },
      include: { account: { select: { platform: true, displayName: true } } },
      orderBy: { fetchedAt: "desc" },
    }),
    db.analyticsSyncState.findMany({ where: { clientId: context.clientId }, orderBy: { updatedAt: "desc" } }),
  ]);
  const metrics = aggregateMetricSnapshots(snapshots, bounds);
  const latestFetchedAt = snapshots[0]?.fetchedAt || null;
  const status = syncStates.find((state) => state.status === "SYNCING")?.status
    || syncStates.find((state) => state.status === "FAILED")?.status
    || syncStates[0]?.status
    || null;
  const freshness = resolveFreshness({ status, latestFetchedAt, now });
  const review = [
    { type: "FACT" as const, text: `${snapshots.length} metric snapshots were evaluated for the current comparison window.` },
    { type: "OBSERVATION" as const, text: metrics.length ? `${metrics.filter((item) => item.current !== null).length} canonical metric dimensions have current-period values.` : "No canonical metric values are available." },
    { type: "HYPOTHESIS" as const, text: "Performance changes require content and audience context before a causal conclusion." },
    { type: "RECOMMENDATION" as const, text: freshness === "fresh" ? "Review account and post-level changes before planning the next experiment." : "Refresh source metrics before making performance decisions." },
  ];
  return { grain, bounds, freshness, latestFetchedAt, metrics, review, syncStates };
}

const analyticsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  platform: z.string().trim().max(100).optional(),
  accountId: z.string().min(1).optional(),
  contentItemId: z.string().min(1).optional(),
  metric: z.enum(canonicalMetricKeys).optional(),
  latestOnly: z.boolean().default(true),
});

function latestSnapshotKey(snapshot: Pick<MetricSnapshot, "metricKey" | "accountId" | "periodStart" | "periodEnd">) {
  const canonical = canonicalizeMetricKey(snapshot.metricKey);
  return `${snapshot.accountId}|${canonical.key || snapshot.metricKey}|${canonical.postId || "account"}|${snapshot.periodStart?.toISOString() || "open"}|${snapshot.periodEnd?.toISOString() || "open"}`;
}

export function selectLatestMetricSnapshots<T extends Pick<MetricSnapshot, "metricKey" | "accountId" | "periodStart" | "periodEnd" | "fetchedAt">>(snapshots: T[]) {
  const latest = new Map<string, T>();
  for (const snapshot of snapshots) {
    const key = latestSnapshotKey(snapshot);
    const current = latest.get(key);
    if (!current || current.fetchedAt < snapshot.fetchedAt) latest.set(key, snapshot);
  }
  return [...latest.values()];
}

export async function queryAnalyticsMetrics(context: RequestContext, raw: unknown = {}) {
  const input = analyticsQuerySchema.parse(raw);
  if (input.from && input.to && input.from >= input.to) throw new AppError("Analytics date range is invalid.", 400, "INVALID_DATE_RANGE");
  if (input.accountId) {
    const account = await db.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId }, select: { id: true } });
    if (!account) throw new AppError("账号不存在或无权访问。", 404, "ACCOUNT_NOT_FOUND");
  }
  const remotePostIds = input.contentItemId
    ? (await db.publishJob.findMany({ where: { clientId: context.clientId, contentVersion: { contentItemId: input.contentItemId } }, select: { remotePostId: true } })).map((job) => job.remotePostId).filter((id): id is string => Boolean(id))
    : null;
  if (input.contentItemId && remotePostIds?.length === 0) {
    const item = await db.contentItem.findFirst({ where: { id: input.contentItemId, clientId: context.clientId }, select: { id: true } });
    if (!item) throw new AppError("内容不存在或无权访问。", 404, "CONTENT_NOT_FOUND");
    return [];
  }
  const snapshots = await db.metricSnapshot.findMany({
    where: {
      clientId: context.clientId,
      ...(input.from || input.to ? { fetchedAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lt: input.to } : {}) } } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.platform ? { account: { platform: input.platform } } : {}),
      ...(remotePostIds ? { OR: remotePostIds.map((postId) => ({ metricKey: { endsWith: `:${postId}` } })) } : {}),
    },
    include: { account: { select: { id: true, platform: true, displayName: true } } },
    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
  });
  const canonical = snapshots
    .map((snapshot) => ({ ...snapshot, canonical: canonicalizeMetricKey(snapshot.metricKey) }))
    .filter((snapshot) => snapshot.canonical.key && (!input.metric || snapshot.canonical.key === input.metric));
  return input.latestOnly ? selectLatestMetricSnapshots(canonical) : canonical;
}

const performanceQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  platform: z.string().optional(),
  accountId: z.string().optional(),
  contentItemId: z.string().optional(),
  sortBy: z.enum(["reach", "views", "engagement", "engagement_rate"]).default("reach"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

export async function getContentPerformance(context: RequestContext, raw: unknown = {}) {
  const input = performanceQuerySchema.parse(raw);
  const jobs = await db.publishJob.findMany({
    where: {
      clientId: context.clientId,
      remotePostId: { not: null },
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.platform ? { account: { platform: input.platform } } : {}),
      ...(input.contentItemId ? { contentVersion: { contentItemId: input.contentItemId } } : {}),
      ...(input.from || input.to ? { publishedAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lt: input.to } : {}) } } : {}),
    },
    include: {
      account: { select: { id: true, platform: true, displayName: true } },
      contentVersion: { include: { assetLinks: { include: { asset: { select: { kind: true } } } }, item: { include: { plan: { include: { product: { select: { id: true, name: true } } } } } } } },
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  });
  const postIds = jobs.map((job) => job.remotePostId!).filter(Boolean);
  const snapshots = postIds.length
    ? await db.metricSnapshot.findMany({ where: { clientId: context.clientId, OR: postIds.map((postId) => ({ metricKey: { endsWith: `:${postId}` } })) }, orderBy: { fetchedAt: "desc" } })
    : [];
  const latest = selectLatestMetricSnapshots(snapshots);
  const metricMap = new Map<string, number | null>();
  for (const snapshot of latest) {
    const canonical = canonicalizeMetricKey(snapshot.metricKey);
    if (canonical.key && canonical.postId) metricMap.set(`${canonical.postId}:${canonical.key}`, snapshot.availability === "AVAILABLE" && snapshot.numericValue !== null ? Number(snapshot.numericValue) : null);
  }
  const rows = jobs.map((job) => {
    const postId = job.remotePostId!;
    const reach = metricMap.get(`${postId}:reach`) ?? null;
    const views = metricMap.get(`${postId}:views`) ?? metricMap.get(`${postId}:video_views`) ?? null;
    const engagement = metricMap.get(`${postId}:engagement`) ?? null;
    const explicitRate = metricMap.get(`${postId}:engagement_rate`);
    const engagementRate = explicitRate !== undefined ? explicitRate : engagement !== null && reach && reach > 0 ? engagement / reach : null;
    return {
      contentItemId: job.contentVersion.contentItemId,
      contentVersionId: job.contentVersionId,
      remotePostId: postId,
      platform: job.account.platform,
      account: job.account,
      publishTime: job.publishedAt || job.createdAt,
      reach,
      views,
      engagement,
      engagementRate,
      mediaType: job.contentVersion.assetLinks[0]?.asset.kind || "NONE",
      theme: job.contentVersion.item.plan.theme,
      product: job.contentVersion.item.plan.product,
    };
  });
  const field = input.sortBy === "engagement_rate" ? "engagementRate" : input.sortBy;
  return rows.sort((left, right) => {
    const leftValue = left[field] ?? Number.NEGATIVE_INFINITY;
    const rightValue = right[field] ?? Number.NEGATIVE_INFINITY;
    const delta = Number(leftValue) - Number(rightValue);
    return (input.direction === "asc" ? delta : -delta) || left.remotePostId.localeCompare(right.remotePostId);
  });
}

export async function comparePosts(context: RequestContext, postIds: string[]) {
  const uniqueIds = [...new Set(postIds)];
  if (uniqueIds.length < 2 || uniqueIds.length > 20) throw new AppError("Provide between 2 and 20 post ids.", 400, "INVALID_COMPARISON_SET");
  const rows = await getContentPerformance(context);
  const selected = rows.filter((row) => uniqueIds.includes(row.remotePostId));
  if (selected.length !== uniqueIds.length) throw new AppError("One or more posts are missing or outside the tenant.", 404, "POST_NOT_FOUND");
  return selected;
}

export async function compareAccounts(context: RequestContext, accountIds: string[], metric: CanonicalMetricKey, from?: Date, to?: Date) {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length < 2 || uniqueIds.length > 20) throw new AppError("Provide between 2 and 20 account ids.", 400, "INVALID_COMPARISON_SET");
  const accounts = await db.socialAccount.findMany({ where: { clientId: context.clientId, id: { in: uniqueIds } }, select: { id: true, displayName: true, platform: true } });
  if (accounts.length !== uniqueIds.length) throw new AppError("One or more accounts are missing or outside the tenant.", 404, "ACCOUNT_NOT_FOUND");
  return Promise.all(accounts.map(async (account) => {
    const metrics = await queryAnalyticsMetrics(context, { accountId: account.id, metric, from, to, latestOnly: false });
    const available = selectLatestMetricSnapshots(metrics).filter((snapshot) => snapshot.availability === "AVAILABLE" && snapshot.numericValue !== null);
    return { account, metric, value: available.length ? available.reduce((sum, snapshot) => sum + Number(snapshot.numericValue), 0) : null, sampleSize: available.length };
  }));
}

export async function analyzePerformancePatterns(context: RequestContext, raw: unknown) {
  const input = z.object({ dimension: z.enum(["media_type", "content_theme", "product", "platform", "publish_day", "publish_hour"]), metric: z.enum(["reach", "views", "engagement", "engagement_rate"]), minimumSampleSize: z.number().int().min(2).max(100).default(3) }).parse(raw);
  const rows = await getContentPerformance(context);
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = input.dimension === "media_type" ? row.mediaType
      : input.dimension === "content_theme" ? row.theme
        : input.dimension === "product" ? row.product?.name || "UNASSIGNED"
          : input.dimension === "platform" ? row.platform
            : input.dimension === "publish_day" ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(row.publishTime)
              : String(row.publishTime.getUTCHours());
    const value = input.metric === "engagement_rate" ? row.engagementRate : row[input.metric];
    if (value !== null) groups.set(key, [...(groups.get(key) || []), Number(value)]);
  }
  return [...groups.entries()].map(([group, values]) => values.length < input.minimumSampleSize
    ? { group, metric: input.metric, sampleSize: values.length, status: "INSUFFICIENT_DATA" as const, average: null }
    : { group, metric: input.metric, sampleSize: values.length, status: "AVAILABLE" as const, average: values.reduce((sum, value) => sum + value, 0) / values.length });
}

export async function getAnalyticsDataHealth(context: RequestContext, now = new Date()) {
  const accounts = await db.socialAccount.findMany({
    where: { clientId: context.clientId },
    include: { metricSnapshots: { orderBy: { fetchedAt: "desc" }, take: 100 } },
    orderBy: [{ platform: "asc" }, { id: "asc" }],
  });
  const syncStates = await db.analyticsSyncState.findMany({ where: { clientId: context.clientId } });
  return accounts.map((account) => {
    const sync = syncStates.find((state) => state.accountId === account.id && state.scope === "metrics");
    const latest = account.metricSnapshots[0] || null;
    const availability = account.metricSnapshots.map((snapshot) => snapshot.availability);
    const status = sync?.status === "SYNCING" ? "syncing"
      : sync?.status === "FAILED" ? "failed"
        : availability.includes("PERMISSION_DENIED") ? "permission_denied"
          : availability.includes("UNSUPPORTED") ? "unsupported"
            : !latest || availability.every((value) => value === "NOT_FETCHED") ? "not_fetched"
              : resolveFreshness({ status: sync?.status, latestFetchedAt: latest.fetchedAt, now });
    return { accountId: account.id, platform: account.platform, status, latestFetchedAt: latest?.fetchedAt || null, syncState: sync || null };
  });
}

export function buildAnalyticsReview(input: { label: string; value: unknown; sampleSize?: number; limitation?: string }[]) {
  return [
    ...input.map((item) => ({ type: "FACT" as const, text: `${item.label}: ${String(item.value)}${item.sampleSize === undefined ? "" : ` (n=${item.sampleSize})`}.` })),
    { type: "OBSERVATION" as const, text: "Computed differences describe association in the available snapshots." },
    { type: "HYPOTHESIS" as const, text: "Audience, timing, creative, and distribution differences may explain the association; causation is not established." },
    { type: "RECOMMENDATION" as const, text: "Validate the pattern with a controlled experiment and fresh source data before changing strategy." },
  ];
}

export const analyticsSchemas = { query: analyticsQuerySchema, performance: performanceQuerySchema };
