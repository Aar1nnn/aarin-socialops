import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { getAnalyticsOverview, type AnalyticsGrain } from "@/services/analytics-service";

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requirePageContext();
  const query = await searchParams;
  const grain: AnalyticsGrain = query.grain === "day" || query.grain === "month" ? query.grain : "week";
  const analytics = await getAnalyticsOverview(context, grain);
  return <OperatorShell context={context}>
    <div className="page-title"><div><h1>数据分析</h1><p className="muted">统一指标来自 MetricSnapshot；缺失、无权限和读取失败不会显示成 0。</p></div></div>
    <div className="grid">
      <section className="card span-8"><form method="get" className="row"><label>周期<select name="grain" defaultValue={grain}><option value="day">日</option><option value="week">周</option><option value="month">月</option></select></label><button>更新视图</button></form></section>
      <section className="card span-4"><span className={`badge ${analytics.freshness === "fresh" ? "ok" : analytics.freshness === "failed" ? "urgent" : ""}`}>{analytics.freshness}</span><p>最近同步：{analytics.latestFetchedAt?.toLocaleString("zh-CN") || "未同步"}</p></section>
      <section className="card span-12"><h2>指标比较</h2><table><thead><tr><th>平台/账号</th><th>指标</th><th>帖子</th><th>当前</th><th>上期</th><th>变化</th><th>数据类型</th><th>不可用状态</th></tr></thead><tbody>{analytics.metrics.map((metric) => <tr key={`${metric.key}-${metric.accountId}-${metric.postId || "account"}`}><td>{metric.platform}<br /><small>{metric.accountId}</small></td><td>{metric.key}</td><td>{metric.postId || "账号级"}</td><td>{metric.current ?? "—"}</td><td>{metric.previous ?? "—"}</td><td>{metric.changePercent === null ? "—" : `${metric.changePercent.toFixed(1)}%`}</td><td>{metric.kinds.join(", ")}</td><td>{Object.entries(metric.unavailable).map(([key, count]) => `${key}: ${count}`).join(" · ") || "—"}</td></tr>)}</tbody></table>{analytics.metrics.length === 0 && <p className="muted">当前比较窗口没有可映射的社媒指标。</p>}</section>
      <section className="card span-12"><h2>运营复盘提示</h2><div className="list">{analytics.review.map((item) => <article className="list-item" key={item.type}><span className="badge">{item.type}</span><p>{item.text}</p></article>)}</div><p className="muted">数学聚合由程序完成；HYPOTHESIS 与 RECOMMENDATION 不是事实。</p></section>
    </div>
  </OperatorShell>;
}
