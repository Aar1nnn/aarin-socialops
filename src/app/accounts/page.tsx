import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { MANUAL_PLATFORMS } from "@/lib/manual-account";
import { platformLabel } from "@/lib/presentation/status";
import { listAccountOperations } from "@/services/account-operations-view";

const healthLabels: Record<string, string> = {
  MANUAL: "人工管理",
  NOT_SELECTED: "未选择",
  CONNECTION_ATTENTION: "连接需处理",
  TOKEN_ATTENTION: "授权需处理",
  PUBLISH_UNVERIFIED: "发布未验证",
  API_SELECTED: "API 账号已选择",
  LEGACY_ACCOUNT: "既有账号",
};

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ platform?: string; mode?: string; view?: string }> }) {
  const context = await requirePageContext();
  const query = await searchParams;
  const accounts = await listAccountOperations(context);
  const platforms = [...new Set(accounts.map((account) => account.platform))];
  const visible = accounts.filter((account) =>
    (!query.platform || account.platform === query.platform)
    && (!query.mode || account.mode === query.mode)
    && (query.view !== "attention" || !["API_SELECTED", "MANUAL"].includes(account.health)));
  const canCreateManual = context.role === "OWNER" || context.role === "OPERATOR";

  return <OperatorShell context={context}>
    <div className="page">
      <PageHeader title="平台与账号" description="先看每个账号能做什么、当前阻碍和下一步，再进入连接管理。" action={
        <a className="button button-secondary button-md" href="/connections">连接与授权管理</a>
      } />
      <section className="panel">
        <SectionHeader title="账号运营视图" description={`${accounts.length} 个账号；发布、指标与互动能力独立判断，人工账号不表示 API 已接通。`} />
        <form action="/accounts" method="get" className="row" aria-label="筛选账号">
          <label>平台<select name="platform" defaultValue={query.platform || ""}>
            <option value="">全部平台</option>
            {platforms.map((platform) => <option key={platform} value={platform}>{platformLabel(platform)}</option>)}
          </select></label>
          <label>管理方式<select name="mode" defaultValue={query.mode || ""}>
            <option value="">全部方式</option><option value="API">API / 既有</option><option value="MANUAL">人工</option>
          </select></label>
          <label>处理状态<select name="view" defaultValue={query.view || ""}>
            <option value="">全部账号</option><option value="attention">需处理</option>
          </select></label>
          <Button type="submit" variant="secondary" size="sm">筛选</Button>
        </form>
        {visible.length === 0 ? <EmptyState
          title={accounts.length ? "没有符合条件的账号" : "还没有账号"}
          description={accounts.length ? "调整筛选条件，或查看全部账号。" : "在连接管理中接入 Meta，或在下方创建人工管理账号。"}
          action={<a href="/connections" className="text-link">查看连接管理</a>}
        /> : <div className="table-scroll" role="region" aria-label="账号运营列表" tabIndex={0}>
          <table style={{ minWidth: 860 }}>
            <thead><tr><th>账号</th><th>管理方式</th><th>账号状态</th><th>发布</th><th>指标</th><th>互动</th><th>问题与下一步</th></tr></thead>
            <tbody>{visible.map((account) => <tr key={account.id}>
              <td><strong>{account.displayName}</strong><span className="cell-meta">{platformLabel(account.platform)}{account.accountType ? ` · ${account.accountType}` : ""}</span>{account.profileUrl ? <a className="cell-meta text-link" href={account.profileUrl} target="_blank" rel="noopener noreferrer">账号主页</a> : null}</td>
              <td>{account.mode === "MANUAL" ? "人工发布" : "API / 既有账号"}</td>
              <td><StatusIndicator label={healthLabels[account.health]} tone={account.health === "API_SELECTED" ? "success" : account.health === "MANUAL" ? "neutral" : "warning"} compact />{account.connectionStatus ? <span className="cell-meta">连接：{account.connectionStatus}</span> : null}</td>
              <td><StatusIndicator value={account.publishCapability} compact /></td>
              <td><StatusIndicator value={account.metricsCapability} compact /></td>
              <td><StatusIndicator value={account.commentsCapability} compact /></td>
              <td><span className="cell-meta">{account.issue}</span><a className="text-link" href={account.nextHref}>{account.nextAction}</a></td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>
      <section className="panel" id="manual-account">
        <SectionHeader title="创建人工管理账号" description="LinkedIn、TikTok、YouTube 在这里登记运营账号；不会创建 OAuth、token 或平台 API 能力。" />
        {canCreateManual ? <div className="form-grid">
          {MANUAL_PLATFORMS.map((platform) => <form key={platform} action="/api/accounts/manual" method="post" className="form-stack">
            <input type="hidden" name="platform" value={platform} />
            <h3>{platformLabel(platform)}</h3>
            <label>账号名称<input name="displayName" required maxLength={200} /></label>
            <label>账号类型<select name="accountType">{(platform === "linkedin"
              ? [["LINKEDIN_MEMBER", "个人"], ["LINKEDIN_ORGANIZATION", "机构"]]
              : platform === "tiktok" ? [["TIKTOK_ACCOUNT", "TikTok 账号"]] : [["YOUTUBE_CHANNEL", "YouTube 频道"]]
            ).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>HTTPS 账号主页<input name="profileUrl" type="url" required placeholder="https://..." /></label>
            <Button type="submit" variant="secondary">创建人工账号</Button>
          </form>)}
        </div> : <Notice title="只读访问">只有所有者和运营者可创建人工管理账号。</Notice>}
      </section>
    </div>
  </OperatorShell>;
}
