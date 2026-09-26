import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, platformLabel } from "@/lib/presentation/status";
import { contentLanes, listContentOperations } from "@/services/content-operations-view";

type Params = { q?: string | string[]; status?: string | string[]; platform?: string | string[]; accountId?: string | string[]; productId?: string | string[]; create?: string | string[] };
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const preview = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 135);

export default async function ContentPage({ searchParams }: { searchParams: Promise<Params> }) {
  const context = await requirePageContext();
  const params = await searchParams;
  const filters = { q: first(params.q), status: first(params.status), platform: first(params.platform), accountId: first(params.accountId), productId: first(params.productId) };
  const { items, total, products, accounts, filterAccounts, client, lane, q } = await listContentOperations(context, filters);
  const strategyRequired = client.mode === "LIVE" && await db.socialStrategy.count({ where: { clientId: context.clientId, status: "CONFIRMED" } }) === 0;
  const readOnly = context.role === "VIEWER";
  const eligibleProducts = products.filter((product) => product.fields.some((field) => field.status === "CONFIRMED" && field.value));
  const createRequested = first(params.create) === "1";
  const searchUrl = (status: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...filters, status })) if (value && value !== "all") query.set(key, value);
    return `/content?${query.toString()}#content-list`;
  };
  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader title="内容中心" eyebrow={client.name} description="找到当前内容，判断版本、人工审核与排期状态，再进入单条内容处理。" action={readOnly ? null : <a className="button button-primary button-md" href="/content?create=1#new-content">创建内容</a>} />
        {readOnly ? <Notice title="只读访问">你可以查看内容和审核记录。创建、编辑、审核和排期需要运营权限。</Notice> : null}
        {strategyRequired ? <Notice title="AI 内容生成需要确认策略" tone="warning">先到<a className="text-link" href="/strategy">运营策略</a>确认当前周期策略。已有内容的人工操作仍可继续。</Notice> : null}
        {!readOnly ? <details className="disclosure" id="new-content" open={createRequested || total === 0}>
          <summary>创建内容</summary>
          <form action="/api/content/generate" method="post" className="disclosure-body form-stack form-width">
            <div className="form-grid">
              <FormField label="产品" htmlFor="content-product"><select id="content-product" name="productId" required><option value="">请选择产品</option>{products.map((product) => { const confirmed = product.fields.filter((field) => field.status === "CONFIRMED" && field.value).length; return <option value={product.id} key={product.id} disabled={confirmed === 0}>{product.name} · 已确认事实 {confirmed}{confirmed === 0 ? "（先确认事实）" : ""}</option>; })}</select></FormField>
              <FormField label="主题" htmlFor="content-theme"><input id="content-theme" name="theme" placeholder="例如：经销商选品要点" required /></FormField>
              <FormField label="业务目的" htmlFor="content-objective" className="span-full"><input id="content-objective" name="objective" defaultValue="获得经销商或批发商的有效询盘" required /></FormField>
            </div>
            <fieldset className="stack-tight content-account-options"><legend>目标账号</legend>
              {accounts.length === 0 ? <Notice title="没有可选账号" tone="warning">先到<a className="text-link" href="/accounts">平台与账号</a>选择账号，才能生成平台版本。</Notice> : accounts.map((account) => <label className="account-option" htmlFor={`target-account-${account.id}`} key={account.id}><input id={`target-account-${account.id}`} type="checkbox" name="accountIds" value={account.id} defaultChecked /><span><strong>{platformLabel(account.platform)}</strong><span className="cell-meta">{account.displayName}</span></span><StatusIndicator value={account.publishCapability} compact /></label>)}
            </fieldset>
            {eligibleProducts.length === 0 ? <Notice title="先建立产品与已确认事实" tone="warning"><a className="text-link" href="/products">前往产品与素材</a>。AI 只会使用已确认的产品事实。</Notice> : null}
            <div><Button type="submit" disabled={eligibleProducts.length === 0 || accounts.length === 0 || strategyRequired}>生成草稿</Button></div>
          </form>
        </details> : null}
        <section className="panel content-search-panel" aria-label="查找内容">
          <form action="/content" method="get" className="content-search-form">
            <FormField label="搜索标题、正文、产品或账号" htmlFor="content-search"><input id="content-search" name="q" type="search" defaultValue={q} placeholder="输入关键词" /></FormField>
            <FormField label="平台" htmlFor="content-platform"><select id="content-platform" name="platform" defaultValue={filters.platform || ""}><option value="">全部平台</option>{[...new Set(filterAccounts.map((account) => account.platform))].map((platform) => <option key={platform} value={platform}>{platformLabel(platform)}</option>)}</select></FormField>
            <FormField label="账号" htmlFor="content-account"><select id="content-account" name="accountId" defaultValue={filters.accountId || ""}><option value="">全部账号</option>{filterAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}{account.isSelected ? "" : "（未选择）"}</option>)}</select></FormField>
            <FormField label="产品" htmlFor="content-filter-product"><select id="content-filter-product" name="productId" defaultValue={filters.productId || ""}><option value="">全部产品</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></FormField>
            {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
            <Button type="submit" variant="secondary">查找</Button>
          </form>
        </section>
        <nav className="subnav" aria-label="内容状态">{contentLanes.map((entry) => <a key={entry.key} href={searchUrl(entry.key)} className={entry.key === lane.key ? "active" : undefined} aria-current={entry.key === lane.key ? "page" : undefined}>{entry.label}</a>)}</nav>
        <section className="panel" id="content-list" aria-label="内容列表">
          <div className="section-header"><div><h2>内容列表</h2><p className="muted">{lane.label} · {total} 条{total > 100 ? "，显示最近 100 条" : ""}</p></div></div>
          {items.length === 0 ? <EmptyState title="没有符合条件的内容" description="调整搜索条件，或创建第一条内容。" action={readOnly ? null : <a className="text-link" href="/content?create=1#new-content">创建内容</a>} /> : <div className="content-card-list">{items.map((item) => {
            const version = item.currentVersion;
            const approval = version?.approvals[0];
            const approved = approval?.decision === "APPROVED" && approval.accountId === item.accountId;
            const job = version?.publishJobs[0];
            return <article className="content-card" key={item.id}>
              <div className="content-card-main"><a className="content-card-title" href={`/content/${item.id}`}>{version?.title?.trim() || item.plan.theme}</a><p>{version ? preview(version.text) : "当前版本缺失"}</p><span className="cell-meta">{client.name} · {item.plan.product?.name || "未关联产品"} · 更新于 {formatDateTime(item.updatedAt, "—", client.timezone)}</span></div>
              <div className="content-card-meta"><span>{platformLabel(item.platform)} · {item.account.displayName}</span><span>当前 v{version?.version ?? "—"}</span><StatusIndicator value={item.status} compact /><span>人工审核：{approved ? "当前版本已批准" : item.status === "REVIEW_PENDING" ? "等待人工审核" : "当前版本未批准"}</span><span>排期：{formatDateTime(item.scheduledAt, "未排期", client.timezone)}</span><span>发布：{job ? <StatusIndicator value={job.status} compact /> : "未进入发布队列"}</span></div>
              <a className="button button-secondary button-sm" href={`/content/${item.id}`} aria-label={`打开${version?.title?.trim() || item.plan.theme}的操作页面`}>打开内容</a>
            </article>;
          })}</div>}
        </section>
      </div>
    </OperatorShell>
  );
}
