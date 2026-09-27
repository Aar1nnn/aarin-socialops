import type { Client, MetricSnapshot, Prisma, PublishJobStatus } from "@prisma/client";
import { canonicalizeMetricKey } from "./analytics-service";
import { AppError } from "../lib/errors";
import { assertValidTimeZone } from "../lib/timezone";
import { resolveAccountPublishingMode } from "../lib/manual-account";
import {
  MonthlyReviewFactsV1Schema,
  type MonthlyMetricSampleV1,
  type MonthlyReviewFactsV1,
} from "../lib/monthly-review-contract";

type MonthlyClient = Pick<Client, "id" | "timezone" | "targetMarkets">;

function localDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}`;
}

// Find the first UTC instant of the local calendar date. This also handles
// zones whose DST transition makes local midnight ambiguous or nonexistent.
function monthBoundaryUtc(year: number, month: number, timeZone: string) {
  const target = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
  const anchorDate = new Date(0);
  anchorDate.setUTCFullYear(year, month - 1, 1);
  anchorDate.setUTCHours(0, 0, 0, 0);
  const anchor = anchorDate.getTime();
  let low = anchor - 2 * 86_400_000;
  let high = anchor + 2 * 86_400_000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(new Date(middle), timeZone) < target) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}

export function resolveMonthlyReviewPeriod(month: string, timeZone: string, asOf = new Date()) {
  assertValidTimeZone(timeZone);
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match || Number(match[1]) === 0 || !Number.isFinite(asOf.getTime())) {
    throw new AppError("请输入有效的报告月份。", 400, "INVALID_REVIEW_MONTH");
  }
  const currentMonth = localDate(asOf, timeZone).slice(0, 7);
  if (month > currentMonth) throw new AppError("不能生成未来月份报告。", 400, "FUTURE_REVIEW_MONTH");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const start = monthBoundaryUtc(year, monthNumber, timeZone);
  const end = monthBoundaryUtc(nextYear, nextMonth, timeZone);
  const partial = month === currentMonth;
  return { month, timeZone, start, end, asOf, partial, effectiveEnd: partial ? asOf : end };
}

function countsForPublished(jobs: Array<{ adapter: string; simulated: boolean; environment: string }>) {
  const result = {
    real: { total: 0, api: 0, manual: 0 },
    simulated: { total: 0, api: 0, manual: 0 },
  };
  for (const job of jobs) {
    const kind = job.simulated || job.environment !== "LIVE" ? "simulated" : "real";
    const execution = job.adapter === "manual" ? "manual" : "api";
    result[kind].total += 1;
    result[kind][execution] += 1;
  }
  return result;
}

const publishStatuses: PublishJobStatus[] = [
  "PENDING", "MANUAL_PENDING", "RUNNING", "RETRY", "WAITING_CONFIGURATION",
  "PUBLISHED", "FAILED", "UNKNOWN", "CANCELLED",
];

type MetricRow = MetricSnapshot & { account: { clientId: string; platform: string } };

function monthlyMetricRows(rows: MetricRow[], period: ReturnType<typeof resolveMonthlyReviewPeriod>) {
  const latest = new Map<string, { row: MetricRow; sample: MonthlyMetricSampleV1 }>();
  let rawSnapshotCount = 0;
  let mockRawSnapshotCount = 0;
  let excludedNonCanonicalCount = 0;
  for (const row of rows) {
    if (row.account.clientId !== row.clientId) continue;
    const bounded = row.periodStart && row.periodEnd && row.periodStart < row.periodEnd;
    const overlaps = bounded && row.periodStart! < period.effectiveEnd && row.periodEnd! > period.start;
    const fetchedInMonth = row.fetchedAt >= period.start && row.fetchedAt < period.effectiveEnd;
    if (bounded ? !overlaps : !fetchedInMonth) continue;
    rawSnapshotCount += 1;
    if (row.dataKind === "MOCK") mockRawSnapshotCount += 1;
    const canonical = canonicalizeMetricKey(row.metricKey);
    if (!canonical.key) {
      excludedNonCanonicalCount += 1;
      continue;
    }
    const coverage = bounded && overlaps
      ? row.periodStart! >= period.start && row.periodEnd! <= period.effectiveEnd ? "WITHIN_MONTH" : "OVERLAPS_MONTH"
      : "UNSCOPED";
    const sample: MonthlyMetricSampleV1 = {
      accountId: row.accountId,
      platform: row.account.platform,
      key: canonical.key,
      postId: canonical.postId,
      periodStartUtc: row.periodStart?.toISOString() || null,
      periodEndUtc: row.periodEnd?.toISOString() || null,
      fetchedAt: row.fetchedAt.toISOString(),
      value: row.availability === "AVAILABLE" && row.numericValue !== null ? row.numericValue.toString() : null,
      availability: row.availability,
      coverage,
    };
    // Data kind is part of the identity: mock observations never replace real ones.
    const key = JSON.stringify([
      row.dataKind, row.accountId, canonical.key, canonical.postId,
      row.periodStart?.toISOString() || null, row.periodEnd?.toISOString() || null,
    ]);
    const existing = latest.get(key);
    if (!existing || row.fetchedAt > existing.row.fetchedAt
      || (row.fetchedAt.getTime() === existing.row.fetchedAt.getTime() && row.id > existing.row.id)) {
      latest.set(key, { row, sample });
    }
  }
  const all = [...latest.values()].sort((a, b) =>
    a.sample.accountId.localeCompare(b.sample.accountId)
      || a.sample.key.localeCompare(b.sample.key)
      || (a.sample.postId || "").localeCompare(b.sample.postId || "")
      || (a.sample.periodStartUtc || "").localeCompare(b.sample.periodStartUtc || "")
      || (a.sample.periodEndUtc || "").localeCompare(b.sample.periodEndUtc || "")
      || a.row.dataKind.localeCompare(b.row.dataKind));
  const partition = (kind: "REAL" | "MOCK") => {
    const samples = all.filter(({ row }) => row.dataKind === kind).map(({ sample }) => sample);
    const latestFetchedAt = samples.reduce<string | null>((latestAt, sample) =>
      latestAt === null || sample.fetchedAt > latestAt ? sample.fetchedAt : latestAt, null);
    const freshness = !latestFetchedAt ? "MISSING"
      : period.asOf.getTime() - new Date(latestFetchedAt).getTime() <= 24 * 60 * 60 * 1000 ? "FRESH" : "STALE";
    return {
      samples,
      availableSampleCount: samples.filter((sample) => sample.availability === "AVAILABLE" && sample.value !== null).length,
      latestFetchedAt,
      freshness,
    };
  };
  return { real: partition("REAL"), mock: partition("MOCK"), rawSnapshotCount, mockRawSnapshotCount, excludedNonCanonicalCount };
}

export async function buildMonthlyReviewFactsV1(
  tx: Prisma.TransactionClient,
  client: MonthlyClient,
  month: string,
  asOf = new Date(),
): Promise<MonthlyReviewFactsV1> {
  const period = resolveMonthlyReviewPeriod(month, client.timezone, asOf);
  const window = { gte: period.start, lt: period.effectiveEnd };
  const [published, cohort, occurredInMonth, importedInMonth, lateImportedForMonth, leads, metricRows, selectedAccounts] = await Promise.all([
    tx.publishJob.findMany({
      where: {
        clientId: client.id, account: { clientId: client.id }, contentVersion: { clientId: client.id },
        status: "PUBLISHED", publishedAt: window, createdAt: { lte: asOf },
      },
      select: { adapter: true, simulated: true, environment: true },
    }),
    tx.publishJob.findMany({
      where: {
        clientId: client.id, account: { clientId: client.id },
        contentVersion: { clientId: client.id }, createdAt: window,
      },
      select: { status: true },
    }),
    tx.interaction.count({
      where: {
        clientId: client.id, occurredAt: window, importedAt: { lte: asOf },
        OR: [{ accountId: null }, { account: { clientId: client.id } }],
      },
    }),
    tx.interaction.count({
      where: {
        clientId: client.id, importedAt: window,
        OR: [{ accountId: null }, { account: { clientId: client.id } }],
      },
    }),
    tx.interaction.count({
      where: {
        clientId: client.id, occurredAt: window,
        importedAt: { gte: period.end, lte: asOf },
        OR: [{ accountId: null }, { account: { clientId: client.id } }],
      },
    }),
    tx.lead.findMany({
      where: {
        clientId: client.id, createdAt: window,
        interaction: {
          clientId: client.id,
          OR: [{ accountId: null }, { account: { clientId: client.id } }],
        },
      },
      select: { priority: true, handoffStatus: true },
    }),
    tx.metricSnapshot.findMany({
      where: {
        clientId: client.id, account: { clientId: client.id },
        fetchedAt: { lte: asOf }, createdAt: { lte: asOf },
        OR: [
          { periodStart: { lt: period.end }, periodEnd: { gt: period.start } },
          { fetchedAt: window },
        ],
      },
      include: { account: { select: { clientId: true, platform: true } } },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
    }),
    tx.socialAccount.findMany({
      where: { clientId: client.id, isSelected: true, createdAt: { lte: asOf } },
      select: { id: true, platform: true, metadata: true },
    }),
  ]);
  const publishingCounts = countsForPublished(published);
  const statuses = Object.fromEntries(publishStatuses.map((status) => [status, 0])) as Record<PublishJobStatus, number>;
  for (const job of cohort) statuses[job.status] += 1;
  const handoffStatuses = {
    NEW: 0, REPLIED: 0, HANDED_OFF: 0,
    WAITING_FEEDBACK: 0, CLOSED: 0, DISMISSED: 0,
  };
  for (const lead of leads) handoffStatuses[lead.handoffStatus] += 1;
  const metricSamples = monthlyMetricRows(metricRows, period);
  const selectedAccountIds = new Set(selectedAccounts.map((account) => account.id));
  const selectedApiAccountIds = new Set(selectedAccounts
    .filter((account) => resolveAccountPublishingMode(account) === "API")
    .map((account) => account.id));
  const realAccountIds = new Set(metricSamples.real.samples.map((sample) => sample.accountId).filter((id) => selectedAccountIds.has(id)));
  const mockAccountIds = new Set(metricSamples.mock.samples.map((sample) => sample.accountId).filter((id) => selectedAccountIds.has(id)));
  const metrics = {
    ...metricSamples,
    accountCoverage: {
      selectedAccountCount: selectedAccountIds.size,
      selectedApiAccountCount: selectedApiAccountIds.size,
      selectedManualAccountCount: selectedAccountIds.size - selectedApiAccountIds.size,
      realAccountCount: realAccountIds.size,
      mockAccountCount: mockAccountIds.size,
      missingRealApiAccountCount: [...selectedApiAccountIds].filter((id) => !realAccountIds.has(id)).length,
    },
  };
  const limitations: string[] = [];
  if (period.partial) limitations.push("当前月份为截至生成时间的部分月份，不能当作完整月比较。");
  if (publishingCounts.simulated.total || metrics.mockRawSnapshotCount) {
    limitations.push("模拟发布与 MOCK 指标单独列示，不能当作真实平台表现。");
  }
  if (!metrics.real.samples.length) limitations.push("本月没有可用的 REAL canonical metric 样本；缺失不等于 0。");
  if (metrics.accountCoverage.missingRealApiAccountCount) {
    limitations.push("生成时部分当前已选 API 账号没有本月 REAL canonical metric 样本；API 指标账号覆盖不完整，人工账号不计入期望分母。");
  }
  if (metrics.real.samples.some((sample) => sample.availability !== "AVAILABLE" || sample.value === null)) {
    limitations.push("部分指标样本不可用或读取失败，其值保留为 null，不按 0 处理。");
  }
  if ([...metrics.real.samples, ...metrics.mock.samples].some((sample) => sample.coverage !== "WITHIN_MONTH")) {
    limitations.push("部分指标缺少完整的月内统计区间或跨越月界，只展示样本，不合并为月度总量。");
  }
  if (metrics.excludedNonCanonicalCount) limitations.push("非 canonical 指标未纳入本报告指标样本。");
  if (metrics.real.samples.length || metrics.mock.samples.length) {
    limitations.push("指标采集新鲜度只说明数据获取时间，不表示内容或平台表现。");
  }
  if (lateImportedForMonth) limitations.push("部分本月发生的互动在月末后才导入；发生时间与导入时间分别统计。");
  if (!client.targetMarkets.length) limitations.push("客户默认目标市场未设置，报告不推断市场表现。");
  const observations = [
    `本月已记录真实发布 ${publishingCounts.real.total} 条，模拟发布 ${publishingCounts.simulated.total} 条，按实际 publishedAt 归月。`,
    `本月创建的发布任务中，生成时仍为 WAITING_CONFIGURATION ${statuses.WAITING_CONFIGURATION} 条、FAILED ${statuses.FAILED} 条、UNKNOWN ${statuses.UNKNOWN} 条；这是创建 cohort 的当前状态，不是本月状态转换次数。`,
    `本月发生的互动 ${occurredInMonth} 条，本月导入的互动 ${importedInMonth} 条；两个口径不可相加。`,
    `本月创建的 Lead 记录 ${leads.length} 条；记录创建数不表示合格线索或成交。`,
    `REAL canonical 指标有 ${metrics.real.samples.length} 个去重后的最新样本，MOCK 有 ${metrics.mock.samples.length} 个。`,
  ];
  return MonthlyReviewFactsV1Schema.parse({
    schemaVersion: "MONTHLY_V1",
    period: {
      month: period.month, timeZone: period.timeZone,
      startUtc: period.start.toISOString(), endUtc: period.end.toISOString(),
      asOf: period.asOf.toISOString(), partial: period.partial,
    },
    publishing: {
      ...publishingCounts,
      createdCohort: { asOf: period.asOf.toISOString(), total: cohort.length, statuses },
    },
    interactions: { occurredInMonth, importedInMonth, lateImportedForMonth },
    leads: {
      recordsCreatedInMonth: leads.length,
      highOrUrgentAsOf: leads.filter((lead) => lead.priority === "HIGH" || lead.priority === "URGENT").length,
      handoffStatusesAsOf: handoffStatuses,
    },
    metrics,
    limitations,
    observations,
  });
}
