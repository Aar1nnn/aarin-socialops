import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";

function jsonList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export default async function InsightsPage() {
  const context = await requirePageContext();
  const [accounts, interactions, leads, metrics, reports, client] = await Promise.all([
    db.socialAccount.findMany({ where: { clientId: context.clientId } }),
    db.interaction.findMany({ where: { clientId: context.clientId }, include: { lead: true }, orderBy: { importedAt: "desc" }, take: 20 }),
    db.lead.findMany({ where: { clientId: context.clientId }, include: { interaction: true }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.metricSnapshot.findMany({ where: { clientId: context.clientId }, include: { account: true }, orderBy: { fetchedAt: "desc" }, take: 30 }),
    db.operationReport.findMany({ where: { clientId: context.clientId }, orderBy: { generatedAt: "desc" }, take: 5 }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
  ]);
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>线索与复盘</h1><p className="muted">人工导入保留原文和来源；系统分类但绝不自动回复。</p></div></div>
      <div className="grid">
        <section className="card span-6"><h2>人工导入互动</h2><form action="/api/interactions" method="post" className="stack">
          <div className="row"><label>平台<select name="platform">{accounts.map((account) => <option key={account.id} value={account.platform}>{account.platform}</option>)}</select></label><label>平台记录 ID<input name="platformRecordId" placeholder="必须稳定且可去重" required /></label></div>
          <label>互动类型<select name="interactionType"><option value="COMMENT">评论</option><option value="MESSAGE">私信（人工导入）</option><option value="MANUAL_NOTE">人工记录</option></select></label>
          <div className="row"><label>作者用户名<input name="authorHandle" /></label><label>来源链接<input name="sourceUrl" type="url" /></label></div>
          <label>原文<textarea name="body" placeholder="例如：We are a distributor. Can you send your wholesale catalog and MOQ?" required /></label>
          <button>导入并分类</button><p className="muted">点赞、表情和泛泛评论不会创建线索。外部文本无法改变审批或发布规则。</p>
        </form></section>
        <section className="card span-6"><h2>数据与复盘动作</h2><div className="stack">
          <p>当前共有 {metrics.length} 条指标快照、{reports.length} 份报告。</p>
          {client.isDemo && <form action="/api/metrics/mock" method="post"><button>生成明确标识的模拟指标</button></form>}
          <form action="/api/reports" method="post"><button>基于现有数据生成复盘</button></form>
          <div className="warning">`NOT_FETCHED`、`UNSUPPORTED`、`READ_FAILED` 与数值 0 分开保存。模拟数据不能当作真实表现。</div>
        </div></section>

        <section className="card span-7"><h2>采购线索与人工交接</h2><div className="list">
          {leads.length === 0 && <p className="muted">尚无有效线索。</p>}
          {leads.map((lead) => <article key={lead.id} className="list-item stack"><div className="row"><span className="badge urgent">{lead.priority}</span><strong>{lead.category}</strong><span className="badge">{lead.handoffStatus}</span></div><div className="preview">{lead.interaction.body}</div><small className="muted">{lead.interaction.platform} · {lead.interaction.authorHandle || "作者未记录"} · {lead.rationale}</small><form action={`/api/leads/${lead.id}`} method="post" className="row"><select name="status" defaultValue={lead.handoffStatus}><option value="NEW">新线索</option><option value="REPLIED">已人工回复</option><option value="HANDED_OFF">已转交吕总</option><option value="WAITING_FEEDBACK">等待反馈</option><option value="CLOSED">已关闭</option><option value="DISMISSED">排除</option></select><input name="feedback" placeholder="销售反馈（可选）" /><button>更新交接</button></form></article>)}
        </div></section>
        <section className="card span-5"><h2>最近互动</h2><div className="list">{interactions.map((interaction) => <article key={interaction.id} className="list-item"><div className="row"><strong>{interaction.platform}</strong><span className={`badge ${interaction.lead ? "urgent" : ""}`}>{interaction.lead ? "已识别线索" : "普通互动"}</span></div><p>{interaction.body}</p><small className="muted">ID: {interaction.platformRecordId}</small></article>)}</div></section>

        <section className="card span-12"><h2>指标覆盖</h2><table><thead><tr><th>平台</th><th>指标</th><th>值</th><th>可用性</th><th>数据类型</th><th>获取时间</th></tr></thead><tbody>{metrics.map((metric) => <tr key={metric.id}><td>{metric.account.platform}</td><td>{metric.metricKey}</td><td>{metric.availability === "AVAILABLE" ? metric.numericValue?.toString() : "—"}</td><td>{metric.availability}</td><td><span className={`badge ${metric.dataKind === "MOCK" ? "mock" : "ok"}`}>{metric.dataKind === "MOCK" ? "模拟" : "真实"}</span></td><td>{metric.fetchedAt.toLocaleString("zh-CN")}</td></tr>)}</tbody></table>{metrics.length === 0 && <p className="muted">尚无指标快照。</p>}</section>
        <section className="card span-12"><h2>运营报告与下一轮实验</h2><div className="list">{reports.map((report) => <article key={report.id} className="list-item stack"><div className="row"><strong>{report.generatedAt.toLocaleString("zh-CN")}</strong>{report.simulated && <span className="badge mock">含模拟数据</span>}</div><div><b>数据局限：</b>{jsonList(report.dataLimitations).join("；") || "当前记录未发现覆盖缺口"}</div><div><b>假设：</b>{jsonList(report.hypotheses).join("；")}</div><div><b>建议实验：</b>{jsonList(report.recommendations).join("；")}</div><details><summary>程序计算事实</summary><pre className="preview">{JSON.stringify(report.facts, null, 2)}</pre></details></article>)}</div></section>
      </div>
    </OperatorShell>
  );
}
