import { DataAvailability, DataKind, Prisma } from "@prisma/client";
import { db } from "../lib/db";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { MonthlyReviewFactsV1Schema, type MonthlyReviewFactsV1 } from "../lib/monthly-review-contract";
import { buildMonthlyReviewFactsV1 } from "./monthly-review-service";

export async function createMockMetricSnapshots(context: RequestContext) {
  assertCanWrite(context);
  const client = await db.client.findUniqueOrThrow({ where: { id: context.clientId } });
  if (!client.isDemo) throw new Error("MOCK_METRICS_ONLY_FOR_DEMO");
  const accounts = await db.socialAccount.findMany({ where: { clientId: context.clientId } });
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return db.metricSnapshot.createMany({
    data: accounts.flatMap((account, index) => [
      {
        clientId: context.clientId,
        accountId: account.id,
        metricKey: "impressions",
        numericValue: 120 + index * 31,
        availability: DataAvailability.AVAILABLE,
        dataKind: DataKind.MOCK,
        periodStart: start,
        periodEnd: now,
        fetchedAt: now,
        source: "mock-metrics-adapter",
      },
      {
        clientId: context.clientId,
        accountId: account.id,
        metricKey: "qualified_leads",
        numericValue: null,
        availability: DataAvailability.NOT_FETCHED,
        dataKind: DataKind.MOCK,
        periodStart: start,
        periodEnd: now,
        fetchedAt: now,
        source: "mock-metrics-adapter",
      },
    ]),
  });
}

export async function generateOperationReport(context: RequestContext, start?: Date, end?: Date) {
  assertCanWrite(context);
  const periodEnd = end ?? new Date();
  const periodStart = start ?? new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [metrics, publishedCounts, leads, interactions, client] = await Promise.all([
    db.metricSnapshot.findMany({
      where: { clientId: context.clientId, fetchedAt: { gte: periodStart, lte: periodEnd } },
      orderBy: { fetchedAt: "desc" },
    }),
    db.publishJob.groupBy({ by: ["simulated"], where: { clientId: context.clientId, status: "PUBLISHED", publishedAt: { gte: periodStart, lte: periodEnd } }, _count: true }),
    db.lead.findMany({ where: { clientId: context.clientId, createdAt: { gte: periodStart, lte: periodEnd } } }),
    db.interaction.count({ where: { clientId: context.clientId, importedAt: { gte: periodStart, lte: periodEnd } } }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
  ]);
  const available = metrics.filter((metric) => metric.availability === "AVAILABLE" && metric.numericValue !== null);
  const limitations: string[] = [];
  if (!metrics.length) limitations.push("本周期没有任何指标快照；不能判断内容表现。");
  if (metrics.some((metric) => metric.availability === "NOT_FETCHED")) limitations.push("部分指标尚未获取，不能把缺失值解释为 0。");
  if (metrics.some((metric) => metric.availability === "UNSUPPORTED")) limitations.push("部分指标接口不支持。");
  if (metrics.some((metric) => metric.availability === "READ_FAILED")) limitations.push("部分指标读取失败，失败值没有按 0 处理。");
  if (!client.targetMarkets.length) limitations.push("目标市场未确认，建议仍属于通用假设。" );
  const mockPublished = publishedCounts.find((entry) => entry.simulated)?._count ?? 0;
  const realPublished = publishedCounts.find((entry) => !entry.simulated)?._count ?? 0;
  const containsMockData = metrics.some((metric) => metric.dataKind === "MOCK") || mockPublished > 0;
  if (containsMockData) limitations.push("本报告包含明确标记的模拟发布或模拟指标，不能作为真实运营表现。" );
  const simulated = containsMockData;
  const facts = {
    publishedPosts: { total: mockPublished + realPublished, real: realPublished, mock: mockPublished },
    importedInteractions: interactions,
    qualifiedLeadRecords: leads.length,
    metricSnapshots: metrics.length,
    availableMetrics: available.map((metric) => ({
      key: metric.metricKey,
      value: metric.numericValue?.toString(),
      kind: metric.dataKind,
      fetchedAt: metric.fetchedAt,
    })),
    warning: "WhatsApp 点击不是有效询盘；询盘也不等于成交。",
  };
  const hypotheses = limitations.length
    ? ["先补齐数据连接和销售反馈，再评价内容或市场效果。"]
    : ["以实际询盘质量而非表面互动决定下一轮内容重点。"];
  const recommendations = [
    client.targetMarkets.length ? "按已确认市场比较平台线索质量。" : "确认目标国家后再批准市场特定方案。",
    "把人工回复与客户销售反馈写回线索状态，建立询盘到结果的可追踪链路。",
  ];
  return db.operationReport.create({
    data: {
      clientId: context.clientId,
      periodStart,
      periodEnd,
      facts,
      dataLimitations: limitations,
      hypotheses,
      recommendations,
      simulated,
    },
  });
}

/** Immutable monthly report. All fact reads and the insert share one database snapshot. */
export async function generateMonthlyOperationReport(context: RequestContext, month: string, asOf = new Date()) {
  assertCanWrite(context);
  return db.$transaction(async (tx) => {
    const client = await tx.client.findUniqueOrThrow({
      where: { id: context.clientId },
      select: { id: true, timezone: true, targetMarkets: true },
    });
    const facts = MonthlyReviewFactsV1Schema.parse(await buildMonthlyReviewFactsV1(tx, client, month, asOf));
    const report = await tx.operationReport.create({
      data: {
        clientId: context.clientId,
        periodStart: new Date(facts.period.startUtc),
        periodEnd: new Date(facts.period.endUtc),
        facts: facts as Prisma.InputJsonValue,
        dataLimitations: facts.limitations,
        hypotheses: [],
        recommendations: deriveMonthlyReviewNextActions(facts),
        simulated: facts.publishing.simulated.total > 0 || facts.metrics.mockRawSnapshotCount > 0,
      },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "MONTHLY_REVIEW_GENERATED",
        entityType: "OperationReport",
        entityId: report.id,
        metadata: { schemaVersion: "MONTHLY_V1", month: facts.period.month, asOf: facts.period.asOf },
      },
    });
    return report;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Operational checks prompted by recorded gaps; these are not performance hypotheses. */
export function deriveMonthlyReviewNextActions(facts: MonthlyReviewFactsV1): string[] {
  const actions: string[] = [];
  if (facts.metrics.accountCoverage.selectedApiAccountCount > 0 && (facts.metrics.real.samples.length === 0 || facts.metrics.accountCoverage.missingRealApiAccountCount > 0)) {
    actions.push("核查当前已选账号的真实指标连接、权限和本月采集覆盖，再决定能否比较表现。");
  }
  if (facts.publishing.createdCohort.statuses.UNKNOWN > 0) {
    actions.push("到发布中心逐条核对 UNKNOWN 任务的外部证据；不把不确定结果当作失败或重新发布依据。");
  }
  if (facts.publishing.createdCohort.statuses.WAITING_CONFIGURATION > 0) {
    actions.push("核查 WAITING_CONFIGURATION 任务的连接和权限要求，再按现有发布流程处理。");
  }
  if (facts.interactions.lateImportedForMonth > 0) {
    actions.push("核对较晚导入互动的发生时间与导入时间，并记录采集延迟对本月覆盖的影响。");
  }
  if (facts.leads.recordsCreatedInMonth > 0 && facts.leads.handoffStatusesAsOf.WAITING_FEEDBACK > 0) {
    actions.push("向客户跟进本月创建且仍在等待反馈的 Lead 记录，补全人工核实结论。");
  }
  if (actions.length === 0) actions.push("核查本月数据覆盖与客户反馈；若发现可检验的问题，再提出下月假设。");
  return actions;
}

export function classifyOperationReportFacts(raw: unknown):
  | { kind: "MONTHLY_V1"; facts: MonthlyReviewFactsV1 }
  | { kind: "LEGACY" | "UNSUPPORTED" } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (record?.schemaVersion === undefined) return { kind: "LEGACY" };
  if (record.schemaVersion !== "MONTHLY_V1") return { kind: "UNSUPPORTED" };
  const parsed = MonthlyReviewFactsV1Schema.safeParse(raw);
  return parsed.success ? { kind: "MONTHLY_V1", facts: parsed.data } : { kind: "UNSUPPORTED" };
}
