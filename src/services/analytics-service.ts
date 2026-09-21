import type { DataAvailability, DataKind, Prisma } from "@prisma/client";
import { z } from "zod";
import type { RequestContext } from "../lib/context";
import { db } from "../lib/db";

export const canonicalMetrics = [
  "impressions", "reach", "views", "video_views", "watch_time", "likes", "comments", "shares", "saves",
  "engagement", "engagement_rate", "followers", "follower_growth", "profile_views", "link_clicks",
] as const;

const aliases: Record<string, string> = {
  plays: "video_views",
  video_view: "video_views",
  watch_time_minutes: "watch_time",
  reactions: "likes",
  post_reactions_total: "likes",
  post_comments_total: "comments",
  post_engagement: "engagement",
  reposts: "shares",
  clicks: "link_clicks",
  outbound: "link_clicks",
  outbound_clicks: "link_clicks",
  follows: "follower_growth",
  engagements: "engagement",
};

export function canonicalMetricKey(key: string): string {
  const normalized = key.trim().toLocaleLowerCase().split(":", 1)[0].replace(/[\s-]+/g, "_");
  return aliases[normalized] || normalized;
}

export type Freshness = "fresh" | "stale" | "syncing" | "failed";

export function metricFreshness(
  snapshot: { availability: DataAvailability; fetchedAt: Date } | undefined,
  now = new Date(),
  staleAfterMs = 24 * 60 * 60 * 1000,
): Freshness {
  if (!snapshot || snapshot.availability === "NOT_FETCHED") return "syncing";
  if (["READ_FAILED", "PERMISSION_DENIED", "UNSUPPORTED"].includes(snapshot.availability)) return "failed";
  return now.getTime() - snapshot.fetchedAt.getTime() > staleAfterMs ? "stale" : "fresh";
}

export type AnalyticsRow = {
  metricKey: string;
  numericValue: Prisma.Decimal | number | string | null;
  availability: DataAvailability;
  dataKind: DataKind;
  periodStart?: Date | null;
  periodEnd: Date | null;
  fetchedAt: Date;
  accountId: string;
  contentItemId?: string | null;
  account: { platform: string };
};

export function metricSnapshotScopeKey(row: AnalyticsRow): string {
  const metricIdentity = row.metricKey.trim().toLocaleLowerCase();
  const scopedPeriod = metricIdentity.includes(":")
    ? "latest-in-window"
    : row.periodStart || row.periodEnd
      ? `${row.periodStart?.toISOString() || "open"}:${row.periodEnd?.toISOString() || "open"}`
      : "latest-in-window";
  return `${row.accountId}:${row.contentItemId || "account"}:${metricIdentity}:${row.dataKind}:${scopedPeriod}`;
}

type PeriodValue = {
  value: number | null;
  availableSamples: number;
  availabilityStates: DataAvailability[];
  dataKinds: DataKind[];
};

function summarize(rows: AnalyticsRow[]): PeriodValue {
  const latestByScope = new Map<string, AnalyticsRow>();
  for (const row of rows) {
    const scope = metricSnapshotScopeKey(row);
    const previous = latestByScope.get(scope);
    if (!previous || row.fetchedAt > previous.fetchedAt) latestByScope.set(scope, row);
  }
  let value: number | null = null;
  let availableSamples = 0;
  const availabilityStates = new Set<DataAvailability>();
  const dataKinds = new Set<DataKind>();
  for (const row of latestByScope.values()) {
    availabilityStates.add(row.availability);
    dataKinds.add(row.dataKind);
    if (row.availability === "AVAILABLE" && row.numericValue !== null) {
      value = (value ?? 0) + Number(row.numericValue);
      availableSamples += 1;
    }
  }
  return { value, availableSamples, availabilityStates: [...availabilityStates], dataKinds: [...dataKinds] };
}

function bucketStart(date: Date, granularity: "day" | "week" | "month"): string {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (granularity === "week") value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  if (granularity === "month") value.setUTCDate(1);
  return value.toISOString();
}

export function aggregateMetricSnapshots(
  rows: AnalyticsRow[],
  period: { currentStart: Date; currentEnd: Date; previousStart: Date; granularity: "day" | "week" | "month" },
  now = new Date(),
) {
  const groups = new Map<string, AnalyticsRow[]>();
  for (const row of rows) {
    const key = canonicalMetricKey(row.metricKey);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const metrics = [...groups.entries()].map(([metricKey, metricRows]) => {
    const timestamp = (row: AnalyticsRow) => row.periodEnd || row.fetchedAt;
    const currentRows = metricRows.filter((row) => timestamp(row) >= period.currentStart && timestamp(row) < period.currentEnd);
    const previousRows = metricRows.filter((row) => timestamp(row) >= period.previousStart && timestamp(row) < period.currentStart);
    const current = summarize(currentRows);
    const previous = summarize(previousRows);
    const changePercent = current.value === null || previous.value === null || previous.value === 0
      ? null
      : ((current.value - previous.value) / previous.value) * 100;
    const latest = [...currentRows].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];
    return { metricKey, current, previous, changePercent, freshness: metricFreshness(latest, now), lastSyncedAt: latest?.fetchedAt ?? null };
  }).sort((a, b) => a.metricKey.localeCompare(b.metricKey));

  const buckets = new Map<string, AnalyticsRow[]>();
  for (const row of rows) {
    const timestamp = row.periodEnd || row.fetchedAt;
    if (timestamp < period.currentStart || timestamp >= period.currentEnd) continue;
    const key = `${bucketStart(timestamp, period.granularity)}:${canonicalMetricKey(row.metricKey)}`;
    buckets.set(key, [...(buckets.get(key) || []), row]);
  }
  const series = [...buckets.entries()].map(([key, bucketRows]) => {
    const separator = key.lastIndexOf(":");
    return { bucket: key.slice(0, separator), metricKey: key.slice(separator + 1), ...summarize(bucketRows) };
  }).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.metricKey.localeCompare(b.metricKey));
  return { metrics, series };
}

export const analyticsQuerySchema = z.object({
  currentStart: z.coerce.date(),
  currentEnd: z.coerce.date(),
  granularity: z.enum(["day", "week", "month"]).default("day"),
  accountId: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  contentItemId: z.string().min(1).optional(),
}).refine((value) => value.currentEnd > value.currentStart, { message: "Analytics end must be after start." });

export async function getSocialAnalytics(context: RequestContext, raw: unknown) {
  const input = analyticsQuerySchema.parse(raw);
  const duration = input.currentEnd.getTime() - input.currentStart.getTime();
  const previousStart = new Date(input.currentStart.getTime() - duration);
  const rows = await db.metricSnapshot.findMany({
    where: {
      clientId: context.clientId,
      fetchedAt: { gte: previousStart, lt: input.currentEnd },
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.contentItemId ? { contentItemId: input.contentItemId } : {}),
      ...(input.platform ? { account: { platform: input.platform } } : {}),
    },
    include: { account: { select: { platform: true } } },
    orderBy: { fetchedAt: "asc" },
  });
  return aggregateMetricSnapshots(rows, { currentStart: input.currentStart, currentEnd: input.currentEnd, previousStart, granularity: input.granularity });
}
