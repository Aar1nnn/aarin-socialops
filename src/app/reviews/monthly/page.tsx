import type { OperationReport } from "@prisma/client";

import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { canWrite } from "@/lib/context";
import { db } from "@/lib/db";
import { MonthlyReviewFactsV1Schema, type MonthlyReviewFactsV1 } from "@/lib/monthly-review-contract";
import { formatDateTime } from "@/lib/presentation/status";
import { buildMonthlyReviewFactsV1 } from "@/services/monthly-review-service";
import { classifyOperationReportFacts, containsSimulatedMonthlyData, deriveMonthlyReviewNextActions } from "@/services/report-service";

type Params = { month?: string | string[]; report?: string | string[] };
type Report = Pick<OperationReport, "id" | "facts" | "generatedAt" | "periodStart" | "periodEnd" | "dataLimitations" | "hypotheses" | "recommendations" | "simulated">;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function currentClientMonth(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const leadCategories = ["PROCUREMENT", "WHOLESALE", "INQUIRY", "CATALOG_REQUEST", "SUPPLY_REQUEST", "GENERAL", "SPAM"] as const;
const cohortStatuses = ["PENDING", "RETRY", "WAITING_CONFIGURATION", "MANUAL_PENDING", "RUNNING", "UNKNOWN", "FAILED", "PUBLISHED", "CANCELLED"] as const;

function CohortPartition({ title, partition }: { title: string; partition: MonthlyReviewFactsV1["publishing"]["createdCohort"]["real"] }) {
  const nonzero = cohortStatuses.filter((status) => partition.statuses[status] > 0);
  return <div className="card span-6 stack-tight">
    <strong>{title}：{partition.total} 个</strong>
    {nonzero.length ? <ul>{nonzero.map((status) => <li key={status}><StatusIndicator value={status} compact /> {partition.statuses[status]}</li>)}</ul> : <p className="muted">本月没有此类任务。</p>}
  </div>;
}

function MetricPartition({ partition, title, timeZone }: { partition: MonthlyReviewFactsV1["metrics"]["real"]; title: string; timeZone: string }) {
  return <div className="card span-6 stack-tight">
    <strong>{title}</strong>
    <p>{partition.samples.length} 组最新快照；其中 {partition.availableSampleCount} 组有可用值。</p>
    <p className="muted">本月样本新鲜度：{partition.freshness}；最近样本采集：{partition.latestFetchedAt ? formatDateTime(new Date(partition.latestFetchedAt), "—", timeZone) : "未采集"}。这是样本时间，不表示当前账号同步健康或内容表现。</p>
    {partition.samples.length ? <details className="technical-details"><summary>查看指标样本及覆盖范围</summary>
      <div className="table-scroll" role="region" aria-label={`${title}指标样本`} tabIndex={0}><table><thead><tr><th>账号／平台</th><th>指标</th><th>值</th><th>可用性</th><th>覆盖</th><th>采集于</th></tr></thead><tbody>
        {partition.samples.map((sample, index) => <tr key={`${sample.accountId}-${sample.key}-${sample.postId ?? "account"}-${index}`}>
          <td>{sample.platform}<span className="cell-meta">{sample.accountId}</span></td>
          <td>{sample.key}{sample.postId ? <span className="cell-meta">帖子 {sample.postId}</span> : null}</td>
          <td>{sample.value ?? "—"}</td><td>{sample.availability}</td><td>{sample.coverage}</td><td>{formatDateTime(new Date(sample.fetchedAt), "—", timeZone)}</td>
        </tr>)}</tbody></table></div>
    </details> : <p className="muted">本月没有可归属的指标样本；缺失值不作 0 处理。</p>}
  </div>;
}

function MonthlyV1Summary({ facts, snapshot, hypotheses, nextActions }: { facts: MonthlyReviewFactsV1; snapshot: boolean; hypotheses: string[]; nextActions: string[] }) {
  const cohort = facts.publishing.createdCohort;
  const cohortTotal = cohort.real.total + cohort.simulated.total;
  const mixed = containsSimulatedMonthlyData(facts);
  const hasActivity = facts.publishing.real.total > 0 || facts.publishing.simulated.total > 0 || cohortTotal > 0 ||
    facts.interactions.occurredInMonth > 0 || facts.interactions.importedInMonth > 0 ||
    facts.leads.recordsCreatedInMonth > 0 || facts.metrics.rawSnapshotCount > 0;
  return <div className="stack">
    <div className="actions">
      <StatusIndicator label="MONTHLY_V1" tone="info" compact />
      {facts.period.partial ? <StatusIndicator label="当月未结束，结果截至采集时间" tone="warning" compact /> : null}
      {mixed ? <StatusIndicator label="含模拟数据，已单独列示" tone="warning" compact /> : null}
    </div>
    <p className="muted">客户时区 {facts.period.timeZone} · {facts.period.month} · UTC 区间 [{facts.period.startUtc}, {facts.period.endUtc}) · 截至 {facts.period.asOf}{snapshot ? "；此处是生成时不可变快照" : "；此处为当前实时预览"}。</p>
    {!hasActivity ? <EmptyState title="本月没有已记录的运营事实" description="发布、互动、线索创建和规范指标均为空；当前的 0 只代表所查询记录的数量，不能推断平台表现。" /> : null}
    <div className="grid">
      <div className="card span-6"><h3>真实发布</h3><p className="number">{facts.publishing.real.total}</p><p className="muted">API {facts.publishing.real.api} · 人工 {facts.publishing.real.manual}；按实际 publishedAt 计入。</p></div>
      <div className="card span-6"><h3>模拟发布</h3><p className="number">{facts.publishing.simulated.total}</p><p className="muted">API {facts.publishing.simulated.api} · 人工 {facts.publishing.simulated.manual}；不计入真实发布。</p></div>
      <div className="card span-6"><h3>互动</h3><p>本月发生 {facts.interactions.occurredInMonth} · 本月导入 {facts.interactions.importedInMonth}</p><p className="muted">本月发生、较晚导入 {facts.interactions.lateImportedForMonth}；发生时间与导入时间分别统计，不相加。</p></div>
      <div className="card span-6"><h3>Lead 记录</h3><p>本月创建 {facts.leads.recordsCreatedInMonth}</p><p className="muted">其中截至采集时高／紧急优先级 {facts.leads.highOrUrgentAsOf}；有非空销售反馈 {facts.leads.salesFeedbackPresentAsOf}。这些只描述本月创建的记录截至采集时的字段，不能表示已核实商机或成交。</p>
        <details className="technical-details"><summary>查看 Lead 分类</summary><ul>{leadCategories.map((category) => <li key={category}><StatusIndicator value={category} compact /> {facts.leads.categoryCounts[category]}</li>)}</ul></details>
      </div>
    </div>
    <div className="stack-tight"><h3>本月创建的发布任务：截至采集时状态</h3><p>共 {cohortTotal} 个；以下按真实与模拟／非 LIVE 任务分列。这是截至 {cohort.asOf} 的当前状态，不是本月状态转换次数，也不同于上面按 publishedAt 归月的已发布数。</p>
      <div className="grid"><CohortPartition title="真实任务" partition={cohort.real} /><CohortPartition title="模拟／非 LIVE 任务" partition={cohort.simulated} /></div>
      {cohort.simulated.statuses.UNKNOWN > 0 ? <p className="muted">模拟／非 LIVE 的 UNKNOWN 只作为模拟任务状态展示，不触发真实外部发布证据对账动作。</p> : null}
    </div>
    <div className="grid"><MetricPartition title="真实指标" partition={facts.metrics.real} timeZone={facts.period.timeZone} /><MetricPartition title="模拟指标" partition={facts.metrics.mock} timeZone={facts.period.timeZone} /></div>
    <div className="card stack-tight"><h3>当前 API 指标同步健康</h3>
      <p className="muted">截至 {facts.metrics.syncHealth.asOf}，仅统计计算时当前已选、支持指标读取的 API 账号；这是连接与同步流程状态，独立于上面的本月指标样本新鲜度。</p>
      <p>新鲜 {facts.metrics.syncHealth.counts.FRESH} · 过期 {facts.metrics.syncHealth.counts.STALE} · 同步中 {facts.metrics.syncHealth.counts.SYNCING} · 失败 {facts.metrics.syncHealth.counts.FAILED} · 无记录 {facts.metrics.syncHealth.counts.MISSING}。</p>
      {facts.metrics.syncHealth.counts.FAILED > 0 || facts.metrics.syncHealth.counts.SYNCING > 0 ? <Notice title="同步状态限制" tone="warning">FAILED 表示指标同步失败，SYNCING 表示仍在进行；两者都不能当作内容表现、真实数值 0 或整个月的历史同步状态。</Notice> : null}
      {facts.metrics.syncHealth.accounts.length ? <details className="technical-details"><summary>查看各账号同步状态</summary><div className="table-scroll" role="region" aria-label="账号指标同步健康" tabIndex={0}><table><thead><tr><th>账号／平台</th><th>当前状态</th><th>最近开始</th><th>最近成功</th><th>最近失败</th></tr></thead><tbody>
        {facts.metrics.syncHealth.accounts.map((account) => <tr key={account.accountId}><td>{account.platform}<span className="cell-meta">{account.accountId}</span></td><td>{account.status}</td><td>{account.lastStartedAt ? formatDateTime(new Date(account.lastStartedAt), "—", facts.period.timeZone) : "—"}</td><td>{account.lastSucceededAt ? formatDateTime(new Date(account.lastSucceededAt), "—", facts.period.timeZone) : "—"}</td><td>{account.lastFailedAt ? formatDateTime(new Date(account.lastFailedAt), "—", facts.period.timeZone) : "—"}</td></tr>)}
      </tbody></table></div></details> : <p className="muted">当前没有适用的 API 指标账号。</p>}
    </div>
    <p className="muted">本次计算时当前已选账号：共 {facts.metrics.accountCoverage.selectedAccountCount} 个，API {facts.metrics.accountCoverage.selectedApiAccountCount} 个、人工 {facts.metrics.accountCoverage.selectedManualAccountCount} 个；{facts.metrics.accountCoverage.realAccountCount} 个有本月真实指标样本，{facts.metrics.accountCoverage.mockAccountCount} 个有模拟样本。具备 METRICS 路径的 API 账号 {facts.metrics.accountCoverage.selectedMetricsApiAccountCount} 个，其中缺少本月 REAL 指标样本 {facts.metrics.accountCoverage.missingRealMetricsApiAccountCount} 个；没有 METRICS 路径的 API 账号与人工账号均不计入指标覆盖分母。账号选择状态是计算时上下文，不表示整个月的历史选择。</p>
    <p className="muted">检索到 {facts.metrics.rawSnapshotCount} 份原始指标快照，其中 MOCK {facts.metrics.mockRawSnapshotCount} 份；{facts.metrics.excludedNonCanonicalCount} 份未映射到规范指标，未混入可比样本。不同时间范围或账号的指标不直接相加。</p>
    {facts.observations.length ? <div className="card"><h3>确定性观察</h3><ul>{facts.observations.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    <div className="card stack-tight"><h3>下月待验证事项</h3>
      <p className="muted">以下只是基于记录缺口的运营核查动作，不表示内容效果或因果关系，也不会自动修改策略。</p>
      {hypotheses.length ? <div><strong>待验证假设</strong><ul>{hypotheses.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : <p>暂无有充分依据的可验证假设。</p>}
      {nextActions.length ? <div><strong>建议核查动作</strong><ul>{nextActions.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : <p>本次快照没有记录建议动作。</p>}
    </div>
    {facts.limitations.length ? <Notice title="数据局限" tone="warning"><ul>{facts.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></Notice> : <Notice title="口径提醒">数据覆盖和采集新鲜度只说明资料状态，不代表内容表现或因果关系。</Notice>}
  </div>;
}

function HistoricalReport({ report, timeZone, selected }: { report: Report; timeZone: string; selected: boolean }) {
  const classified = classifyOperationReportFacts(report.facts);
  const version = classified.kind;
  return <article className="structured-row stack" id={`report-${report.id}`}>
    <div className="toolbar"><div><strong>{formatDateTime(report.generatedAt, "—", timeZone)}</strong><p className="cell-meta">原始记录周期：{formatDateTime(report.periodStart, "—", timeZone)} 至 {formatDateTime(report.periodEnd, "—", timeZone)}</p></div>
      <StatusIndicator label={version === "LEGACY" ? "旧版报告" : version === "MONTHLY_V1" ? "MONTHLY_V1" : "未知版本"} tone={version === "MONTHLY_V1" ? "info" : "warning"} compact /></div>
    {selected ? <Notice title="刚生成的快照">这份报告保留生成当时的事实；以后源数据更新不会改写它。</Notice> : null}
    {classified.kind === "MONTHLY_V1" ? <MonthlyV1Summary facts={classified.facts} snapshot hypotheses={stringList(report.hypotheses)} nextActions={stringList(report.recommendations)} /> : version === "LEGACY" ? <>
      <Notice title="旧版报告口径" tone="warning">该报告没有 schemaVersion，保留原有字段与文字。它按旧规则生成，不能用 MONTHLY_V1 的月度口径解读。</Notice>
      <div><strong>原有数据局限</strong><p>{stringList(report.dataLimitations).join("；") || "未记录。"}</p></div>
      <div><strong>原有假设</strong><p>{stringList(report.hypotheses).join("；") || "未记录。"}</p></div>
      <div><strong>原有建议</strong><p>{stringList(report.recommendations).join("；") || "未记录。"}</p></div>
      <details className="technical-details"><summary>查看旧版原始事实</summary><pre style={{ maxWidth: "100%", overflowX: "auto" }}>{JSON.stringify(report.facts, null, 2)}</pre></details>
    </> : <Notice title="无法按已知版本展示" tone="warning">报告已保留，但 schemaVersion 不受支持或 MONTHLY_V1 数据未通过验证；请核查原始记录。</Notice>}
  </article>;
}

export default async function MonthlyReviewPage({ searchParams }: { searchParams: Promise<Params> }) {
  const context = await requirePageContext();
  const query = await searchParams;
  const client = await db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { id: true, timezone: true, targetMarkets: true } });
  const asOf = new Date();
  const currentMonth = currentClientMonth(client.timezone, asOf);
  const month = first(query.month) ?? currentMonth;
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1 && month <= currentMonth;
  const selectedId = first(query.report);
  const [preview, reports, selectedReport] = await Promise.all([
    validMonth ? db.$transaction((tx) => buildMonthlyReviewFactsV1(tx, client, month, asOf), { isolationLevel: "RepeatableRead" }) : Promise.resolve(null),
    db.operationReport.findMany({ where: { clientId: context.clientId }, orderBy: [{ generatedAt: "desc" }, { id: "desc" }], take: 50 }),
    selectedId ? db.operationReport.findFirst({ where: { id: selectedId, clientId: context.clientId } }) : Promise.resolve(null),
  ]);
  const parsedPreview = preview ? MonthlyReviewFactsV1Schema.parse(preview) : null;
  const visibleReports = selectedReport && !reports.some((report) => report.id === selectedReport.id)
    ? [selectedReport, ...reports]
    : reports;
  const orderedReports = selectedId ? [...visibleReports].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId)) : visibleReports;
  return <OperatorShell context={context}><div className="page">
    <PageHeader title="月度运营复盘" description="按客户时区查看确定性事实，并保存有版本的历史快照。不同来源和时间口径分别列示。" />
    <section className="section"><SectionHeader title="选择月份" description="未来月份不可生成；当前月明确标注为截至当前时间的部分月份。" />
      <form action="/reviews/monthly" method="get" className="form-stack form-width"><FormField label="客户时区月份" htmlFor="review-month"><input id="review-month" type="month" name="month" value={month} max={currentMonth} required /></FormField><div className="actions"><Button type="submit" variant="secondary">查看月份</Button></div></form>
      {!validMonth ? <Notice title="月份无效" tone="warning">请选择不晚于 {currentMonth} 的有效月份。</Notice> : null}
    </section>
    {parsedPreview ? <section className="section"><SectionHeader title={`${month} 实时事实`} description="此视图会随真实记录更新；生成报告后，保存的快照不会重算。" />
      <MonthlyV1Summary facts={parsedPreview} snapshot={false} hypotheses={[]} nextActions={deriveMonthlyReviewNextActions(parsedPreview)} />
      {canWrite(context.role) ? <form action="/api/reports" method="post" className="actions"><input type="hidden" name="month" value={month} /><Button type="submit">保存本月快照</Button></form> : <Notice title="只读访问">当前角色可以查看实时事实和历史快照，不能生成新报告。</Notice>}
    </section> : null}
    <section className="section"><SectionHeader title="历史报告" description="每次生成都会留下独立记录；MONTHLY_V1 和旧报告按各自口径展示。" />
      {orderedReports.length ? <div className="list">{orderedReports.map((report) => <HistoricalReport key={report.id} report={report} timeZone={client.timezone} selected={report.id === selectedId} />)}</div> : <EmptyState title="还没有历史报告" description="选择月份后可保存第一份月度快照。" />}
    </section>
  </div></OperatorShell>;
}
