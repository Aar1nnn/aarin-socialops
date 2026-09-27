import { OperatorShell } from "@/components/operator-shell";
import { EmptyState, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { formatDateTime, platformLabel } from "@/lib/presentation/status";
import { getClientReadiness, type ReadinessCheck, type ReadinessStatus } from "@/services/client-readiness-service";

const statusLabel: Record<ReadinessStatus, string> = {
  READY: "可继续",
  ATTENTION: "需留意",
  BLOCKED: "当前阻断",
  NOT_APPLICABLE: "不适用",
};

const statusTone = {
  READY: "success",
  ATTENTION: "warning",
  BLOCKED: "danger",
  NOT_APPLICABLE: "neutral",
} as const;

function CheckCard({ value }: { value: ReadinessCheck }) {
  return <article className="card span-6" style={{ overflowWrap: "anywhere" }} data-readiness-key={value.key} data-readiness-status={value.status}>
    <div className="toolbar">
      <h3 style={{ margin: 0 }}>{value.title}</h3>
      <StatusIndicator label={statusLabel[value.status]} tone={statusTone[value.status]} compact />
    </div>
    <p className="muted">{value.detail}</p>
    {value.nextHref && value.nextAction ? <a className="text-link" href={value.nextHref}>{value.nextAction} →</a> : null}
  </article>;
}

export default async function ReadinessPage() {
  const context = await requirePageContext();
  const readiness = await getClientReadiness(context);
  return <OperatorShell context={context}><div className="page">
    <PageHeader
      title="客户运营准备度"
      eyebrow={readiness.client.name}
      description="按当前真实工作流展示可用能力、限制和下一步。结果是实时读取，不是评分，也不会自动修改配置。"
      action={<a className="button button-secondary button-md" href="/accounts">查看平台与账号</a>}
    />
    <p className="cell-meta">读取时间：{formatDateTime(readiness.assessedAt, "—", readiness.client.timezone)}（{readiness.client.timezone}） · 客户模式：{readiness.client.mode}</p>
    {context.role === "VIEWER" ? <Notice title="只读访问">你可以查看准备度和下一步；修改客户配置、内容或发布任务需要运营权限。</Notice> : null}
    <Notice title="按能力判断" tone="info">人工内容创建、AI 内容完整工作流、真实 API 发布和人工发布分别判断。单条内容仍须经过当前版本、人工批准、素材与排期校验。</Notice>

    <section className="panel" id="foundations">
      <SectionHeader title="品牌与运营策略" description="品牌长期约束、当前运营策略和产品已确认事实各有独立职责。" />
      <div className="grid">{readiness.foundations.map((value) => <CheckCard key={value.key} value={value} />)}</div>
    </section>

    <section className="panel" id="content-readiness">
      <SectionHeader title="内容工作流" description="历史已发布、已取消的内容不计入当前产品资料版本阻碍。" />
      <div className="grid">{readiness.content.map((value) => <CheckCard key={value.key} value={value} />)}</div>
    </section>

    <section className="panel" id="publishing-readiness">
      <SectionHeader title="待处理发布事实" description="这里只列当前未解决任务；历史失败不会永久阻断客户。UNKNOWN 必须先核实外部事实。" />
      <div className="grid">{readiness.publishing.map((value) => <CheckCard key={value.key} value={value} />)}</div>
    </section>

    <section className="panel" id="follow-up-readiness">
      <SectionHeader title="数据复盘与线索交接" description="REAL 指标是否存在、数据是否新鲜，与运营表现分别判断；没有线索记录不构成阻断。" />
      <div className="grid">{readiness.followUp.map((value) => <CheckCard key={value.key} value={value} />)}</div>
    </section>

    <section className="panel" id="account-readiness">
      <SectionHeader title="各账号能力" description="发布、指标和互动分开判断。Instagram API 的 Registry 外部验证限制会明确显示，人工账号不会被误写成 API 已接通。" />
      {readiness.accounts.length === 0 ? <EmptyState title="尚无账号" description="先在平台与账号页登记人工账号，或在连接管理中接入已支持的 API 账号。" action={<a href="/accounts" className="text-link">查看平台与账号</a>} /> :
        <div className="grid">{readiness.accounts.map((account) => <article key={account.id} className="card span-6" style={{ overflowWrap: "anywhere" }} data-account-id={account.id}>
          <div className="toolbar"><div><h3 style={{ margin: 0 }}>{account.displayName}</h3><span className="cell-meta">{platformLabel(account.platform)} · {account.mode === "MANUAL" ? "人工管理" : "API / 既有账号"}</span></div>
            <StatusIndicator label={statusLabel[account.publishing.status]} tone={statusTone[account.publishing.status]} compact /></div>
          <div className="stack-tight" style={{ marginTop: 14 }}>
            {[account.publishing, account.media, account.metrics, account.interactions].map((value) => <div key={value.key} data-readiness-key={value.key} data-readiness-status={value.status}>
              <div className="toolbar"><strong>{value.title}</strong><StatusIndicator label={statusLabel[value.status]} tone={statusTone[value.status]} compact /></div>
              <p className="cell-meta" style={{ margin: "5px 0" }}>{value.detail}</p>
              {value.nextHref && value.nextAction ? <a href={value.nextHref} className="text-link">{value.nextAction} →</a> : null}
            </div>)}
            {account.unresolvedManualJobs || account.unresolvedApiJobs ? <p className="cell-meta">当前未解决发布任务：人工 {account.unresolvedManualJobs} · API {account.unresolvedApiJobs}。历史任务按 PublishJob.adapter 解释。</p> : null}
          </div>
        </article>)}</div>}
    </section>

    <section className="panel" id="product-readiness">
      <SectionHeader title="产品事实" description="只统计有值的 CONFIRMED ProductField。缺少已确认事实会阻断现有 AI 内容完整流程；人工内容创建可不关联产品。" action={<a className="text-link" href="/products">查看所有产品</a>} />
      {readiness.products.length === 0 ? <EmptyState title="尚无产品" description="如需走现有 AI 内容完整工作流，请先创建产品并确认事实；人工内容可直接创建。" action={<a className="text-link" href="/products">创建产品</a>} /> :
        <div className="grid">{readiness.products.map((product) => <article key={product.id} className="card span-6" style={{ overflowWrap: "anywhere" }}>
          <div className="toolbar"><strong>{product.name}</strong><StatusIndicator label={statusLabel[product.status]} tone={statusTone[product.status]} compact /></div>
          <p className="cell-meta">已确认事实：{product.confirmedFactCount} 条</p>
          <a className="text-link" href={`/products/${product.id}`}>{product.confirmedFactCount ? "查看产品事实" : "确认产品事实"} →</a>
        </article>)}</div>}
    </section>
  </div></OperatorShell>;
}
