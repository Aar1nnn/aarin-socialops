import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSocialAnalytics } from "@/services/analytics-service";

type Search = Record<string, string | string[] | undefined>;
const one = (search: Search, key: string) => Array.isArray(search[key]) ? search[key]?.[0] : search[key];
const dateInput = (candidate: string | undefined) => {
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate ? undefined : candidate;
};

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const context = await requirePageContext();
  const search = await searchParams;
  const selectedEnd = dateInput(one(search, "end"));
  const selectedStart = dateInput(one(search, "start"));
  const currentEnd = selectedEnd ? new Date(new Date(`${selectedEnd}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000) : new Date();
  const currentStart = selectedStart ? new Date(`${selectedStart}T00:00:00.000Z`) : new Date(currentEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [analytics, accounts] = await Promise.all([
    getSocialAnalytics(context, { currentStart, currentEnd, granularity: one(search, "granularity") || "day", accountId: one(search, "accountId") || undefined, platform: one(search, "platform") || undefined }),
    db.socialAccount.findMany({ where: { clientId: context.clientId }, orderBy: [{ platform: "asc" }, { displayName: "asc" }] }),
  ]);
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>社媒数据分析</h1><p className="muted">程序计算当前/上期与变化率；AI 复盘只能在事实层之上输出观察和假设。</p></div></div>
      <section className="card" style={{ marginBottom: "1rem" }}><form method="get" className="row"><label>开始<input type="date" name="start" defaultValue={currentStart.toISOString().slice(0, 10)} /></label><label>结束（含）<input type="date" name="end" defaultValue={selectedEnd || currentEnd.toISOString().slice(0, 10)} /></label><label>粒度<select name="granularity" defaultValue={one(search, "granularity") || "day"}><option value="day">日</option><option value="week">周</option><option value="month">月</option></select></label><label>平台<select name="platform" defaultValue={one(search, "platform") || ""}><option value="">全部</option>{[...new Set(accounts.map((account) => account.platform))].map((platform) => <option key={platform}>{platform}</option>)}</select></label><label>账号<select name="accountId" defaultValue={one(search, "accountId") || ""}><option value="">全部</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.displayName}</option>)}</select></label><button>更新</button></form></section>
      <section className="card"><h2>统一指标</h2><table><thead><tr><th>指标</th><th>当前</th><th>上期</th><th>变化</th><th>Freshness</th><th>可用性</th><th>数据类型</th><th>最后同步</th></tr></thead><tbody>{analytics.metrics.map((metric) => <tr key={metric.metricKey}><td>{metric.metricKey}</td><td>{metric.current.value ?? "—"}</td><td>{metric.previous.value ?? "—"}</td><td>{metric.changePercent === null ? "—" : `${metric.changePercent.toFixed(1)}%`}</td><td><span className={`badge ${metric.freshness === "fresh" ? "ok" : metric.freshness === "failed" ? "urgent" : ""}`}>{metric.freshness}</span></td><td>{metric.current.availabilityStates.join(", ") || "NOT_FETCHED"}</td><td>{metric.current.dataKinds.join(", ") || "—"}</td><td>{metric.lastSyncedAt?.toLocaleString("zh-CN") || "—"}</td></tr>)}</tbody></table>{analytics.metrics.length === 0 && <p className="muted">没有快照；缺失不会显示为数值 0。</p>}</section>
      <section className="card" style={{ marginTop: "1rem" }}><h2>时间序列</h2><table><thead><tr><th>Bucket</th><th>指标</th><th>值</th><th>可用样本</th><th>缺失态</th><th>REAL/MOCK</th></tr></thead><tbody>{analytics.series.map((point) => <tr key={`${point.bucket}:${point.metricKey}`}><td>{point.bucket.slice(0, 10)}</td><td>{point.metricKey}</td><td>{point.value ?? "—"}</td><td>{point.availableSamples}</td><td>{point.availabilityStates.join(", ")}</td><td>{point.dataKinds.join(", ")}</td></tr>)}</tbody></table></section>
    </OperatorShell>
  );
}
