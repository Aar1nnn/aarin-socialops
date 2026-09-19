import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { listPlatformConnections } from "@/services/platform-connection-service";

export default async function ConnectionsPage() {
  const context = await requirePageContext();
  const connections = await listPlatformConnections(context);
  return (
    <OperatorShell context={context}>
      <div className="page-title">
        <div>
          <h1>平台连接</h1>
          <p className="muted">OAuth 授权属于当前客户；发现账号后仍需人工选择，token 不会显示在页面。</p>
        </div>
        <form action="/api/connections/meta/start" method="post">
          <input type="hidden" name="returnTo" value="/connections" />
          <button disabled={context.role !== "OWNER"}>连接 Meta</button>
        </form>
      </div>

      <div className="grid">
        {connections.length === 0 && (
          <section className="card span-12 stack">
            <h2>尚无 OAuth 连接</h2>
            <p className="muted">配置服务器端 `META_APP_ID`、`META_APP_SECRET`、`META_REDIRECT_URI` 和 `TOKEN_ENCRYPTION_KEY` 后，由 OWNER 发起连接。</p>
            <div className="warning">LinkedIn 与 TikTok 仅保留边界，本阶段没有真实授权按钮，也不会伪装成已接入。</div>
          </section>
        )}
        {connections.map((connection) => (
          <section className="card span-12 stack" key={connection.id}>
            <div className="row">
              <h2>{connection.provider}</h2>
              <span className={`badge ${connection.status === "CONNECTED" ? "ok" : "urgent"}`}>{connection.status}</span>
              <small className="muted">连接于 {connection.connectedAt?.toLocaleString("zh-CN") || "—"}</small>
            </div>
            <p className="muted">授权主体：{connection.externalPrincipalId || "未返回"} · Access token 到期：{connection.accessTokenExpiresAt?.toLocaleString("zh-CN") || "平台未返回"} · 最近刷新：{connection.lastRefreshedAt?.toLocaleString("zh-CN") || "—"}</p>
            <p className="muted">已授予 scopes：{connection.scopes.join(", ") || "未读取"}</p>
            {connection.lastErrorCode && <div className="error">{connection.lastErrorCode}：{connection.lastErrorMessage || "连接异常"}</div>}

            <form action={`/api/connections/${connection.id}/select-accounts`} method="post" className="stack">
              <h3>发现的账号</h3>
              {connection.accounts.length === 0 && <p className="muted">未发现可管理 Page。检查授权范围、Page 角色和 Meta App 模式。</p>}
              {connection.accounts.map((account) => (
                <label className="account-option" key={account.id}>
                  <input type="checkbox" name="accountIds" value={account.id} defaultChecked={account.isSelected} />
                  <span>
                    <strong>{account.displayName}</strong> <span className="badge">{account.accountType || account.platform}</span><br />
                    <small className="muted">{account.platform} · {account.externalAccountId || "无远端 ID"} · 发布 {account.publishCapability} · 指标 {account.metricsCapability} · 评论 {account.commentsCapability}</small>
                  </span>
                </label>
              ))}
              <button disabled={context.role !== "OWNER" || connection.accounts.length === 0}>保存账号选择</button>
            </form>
            <div className="row">
              <form action={`/api/connections/${connection.id}/refresh`} method="post"><button className="secondary" disabled={context.role !== "OWNER"}>刷新 token（provider 支持时）</button></form>
              <form action={`/api/connections/${connection.id}/disconnect`} method="post"><button className="danger" disabled={context.role !== "OWNER"}>断开并清除本地 token</button></form>
            </div>
          </section>
        ))}
        <section className="card span-6 stack">
          <div className="row"><h2>LinkedIn</h2><span className="badge">暂不可用</span></div>
          <p className="muted">仅保留 provider 与 adapter 边界；本阶段没有 OAuth、发布或指标实现。</p>
          <button disabled>连接 LinkedIn</button>
        </section>
        <section className="card span-6 stack">
          <div className="row"><h2>TikTok</h2><span className="badge">暂不可用</span></div>
          <p className="muted">仅保留 provider 与 adapter 边界；本阶段没有 OAuth、发布或指标实现。</p>
          <button disabled>连接 TikTok</button>
        </section>
        <section className="card span-12">
          <h2>能力边界</h2>
          <p className="muted">Meta：本阶段实现 OAuth、Page/关联 Instagram 账号发现与 Facebook Page 发布复用。Instagram 发布、LinkedIn、TikTok、自动私信、自动回复和群组自动化仍未实现。</p>
        </section>
      </div>
    </OperatorShell>
  );
}
