import { z } from "zod";

const count = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });

const publishingCounts = z.object({ total: count, api: count, manual: count }).strict();
const jobStatuses = z.object({
  PENDING: count,
  MANUAL_PENDING: count,
  RUNNING: count,
  RETRY: count,
  WAITING_CONFIGURATION: count,
  PUBLISHED: count,
  FAILED: count,
  UNKNOWN: count,
  CANCELLED: count,
}).strict();
const cohortPartition = z.object({ total: count, statuses: jobStatuses }).strict();
const syncStatus = z.enum(["FRESH", "STALE", "SYNCING", "FAILED", "MISSING"]);

export const MonthlyMetricSampleV1Schema = z.object({
  accountId: z.string().min(1),
  platform: z.string().min(1),
  key: z.enum([
    "impressions", "reach", "views", "video_views", "watch_time",
    "likes", "comments", "shares", "saves", "engagement", "engagement_rate",
    "followers", "follower_growth", "profile_views", "link_clicks",
  ]),
  postId: z.string().nullable(),
  periodStartUtc: instant.nullable(),
  periodEndUtc: instant.nullable(),
  fetchedAt: instant,
  value: z.string().nullable(),
  availability: z.enum(["AVAILABLE", "NOT_FETCHED", "UNSUPPORTED", "PERMISSION_DENIED", "READ_FAILED"]),
  coverage: z.enum(["WITHIN_MONTH", "OVERLAPS_MONTH", "UNSCOPED"]),
}).strict();

const metricPartition = z.object({
  samples: z.array(MonthlyMetricSampleV1Schema),
  availableSampleCount: count,
  latestFetchedAt: instant.nullable(),
  freshness: z.enum(["FRESH", "STALE", "MISSING"]),
}).strict();

export const MonthlyReviewFactsV1Schema = z.object({
  schemaVersion: z.literal("MONTHLY_V1"),
  period: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    timeZone: z.string().min(1),
    startUtc: instant,
    endUtc: instant,
    asOf: instant,
    partial: z.boolean(),
  }).strict(),
  publishing: z.object({
    real: publishingCounts,
    simulated: publishingCounts,
    createdCohort: z.object({
      asOf: instant,
      real: cohortPartition,
      simulated: cohortPartition,
    }).strict(),
  }).strict(),
  interactions: z.object({
    occurredInMonth: count,
    importedInMonth: count,
    lateImportedForMonth: count,
  }).strict(),
  leads: z.object({
    recordsCreatedInMonth: count,
    highOrUrgentAsOf: count,
    categoryCounts: z.object({
      PROCUREMENT: count, WHOLESALE: count, INQUIRY: count,
      CATALOG_REQUEST: count, SUPPLY_REQUEST: count, GENERAL: count, SPAM: count,
    }).strict(),
    salesFeedbackPresentAsOf: count,
    handoffStatusesAsOf: z.object({
      NEW: count, REPLIED: count, HANDED_OFF: count,
      WAITING_FEEDBACK: count, CLOSED: count, DISMISSED: count,
    }).strict(),
  }).strict(),
  metrics: z.object({
    real: metricPartition,
    mock: metricPartition,
    rawSnapshotCount: count,
    mockRawSnapshotCount: count,
    excludedNonCanonicalCount: count,
    accountCoverage: z.object({
      selectedAccountCount: count,
      selectedApiAccountCount: count,
      selectedManualAccountCount: count,
      selectedMetricsApiAccountCount: count,
      realAccountCount: count,
      mockAccountCount: count,
      missingRealMetricsApiAccountCount: count,
    }).strict(),
    syncHealth: z.object({
      asOf: instant,
      scope: z.literal("metrics"),
      accounts: z.array(z.object({
        accountId: z.string().min(1),
        platform: z.string().min(1),
        status: syncStatus,
        lastStartedAt: instant.nullable(),
        lastSucceededAt: instant.nullable(),
        lastFailedAt: instant.nullable(),
      }).strict()),
      counts: z.object({ FRESH: count, STALE: count, SYNCING: count, FAILED: count, MISSING: count }).strict(),
    }).strict(),
  }).strict(),
  limitations: z.array(z.string().min(1)),
  observations: z.array(z.string().min(1)),
}).strict();

export type MonthlyReviewFactsV1 = z.infer<typeof MonthlyReviewFactsV1Schema>;
export type MonthlyMetricSampleV1 = z.infer<typeof MonthlyMetricSampleV1Schema>;
