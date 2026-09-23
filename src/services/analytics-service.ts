import type { AnalyticsFreshnessStatus, DataAvailability, DataKind, MetricSnapshot } from "@prisma/client";
import { db } from "../lib/db";
import type { RequestContext } from "../lib/context";

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
