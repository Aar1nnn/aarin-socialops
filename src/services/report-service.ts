import { DataAvailability, DataKind } from "@prisma/client";
import { db } from "../lib/db";
import { assertCanWrite, type RequestContext } from "../lib/context";

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
    "把人工回复与吕总反馈写回线索状态，建立询盘到结果的可追踪链路。",
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
