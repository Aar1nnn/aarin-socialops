import { OperatorShell } from "@/components/operator-shell";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  SectionHeader,
  StatusIndicator,
} from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, platformLabel, statusLabel } from "@/lib/presentation/status";
import { listPlatformConnections } from "@/services/platform-connection-service";

const accountTypeLabels: Record<string, string> = {
  FACEBOOK_PAGE: "Facebook Page",
  INSTAGRAM_PROFESSIONAL: "Instagram 专业账号",
};

function accountTypeLabel(accountType: string | null, platform: string) {
  return accountType ? accountTypeLabels[accountType] ?? platformLabel(platform) : platformLabel(platform);
}

function supportsTokenRefresh(provider: string) {
  // Only opt providers in after their auth adapter implements refresh token exchange.
  const refreshCapableProviders = new Set<string>();
  return refreshCapableProviders.has(provider);
}

function connectionRecoveryMessage(status: string) {
  if (status === "TOKEN_EXPIRING" || status === "TOKEN_EXPIRED") {
    return "授权即将或已经到期，请重新连接以更新授权。";
  }
  if (status === "PERMISSION_MISSING") {
    return "当前授权缺少所需权限，请在 Meta 中确认权限后重新连接。";
  }
  if (status === "REVIEW_REQUIRED") {
    return "当前连接需要人工复核，请检查应用模式、Page 角色和授权范围。";
  }
  return "连接暂不可用，请重新连接；如仍失败，请展开技术详情查看错误信息。";
}

export default async function ConnectionsPage() {
  const context = await requirePageContext();
  const [connections, workspace] = await Promise.all([
    listPlatformConnections(context),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  const canManageConnections = context.role === "OWNER";
  const hasMetaConnection = connections.some((connection) => connection.provider === "META");

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader
          title="平台连接"
          description="管理用于发布和数据同步的平台账号。"
          action={(
            <form action="/api/connections/meta/start" method="post">
              <input type="hidden" name="returnTo" value="/connections" />
              <Button disabled={!canManageConnections} title={!canManageConnections ? "只有工作区所有者可管理平台连接" : undefined}>
                {hasMetaConnection ? "重新连接 Meta" : "连接 Meta"}
              </Button>
            </form>
          )}
        />

        {!canManageConnections ? (
          <Notice title="只读访问">
            当前角色可查看连接和账号能力。连接、选择账号或断开授权需要工作区所有者操作。
          </Notice>
        ) : null}

        {connections.length === 0 ? (
          <section className="section">
            <EmptyState
              title="还没有平台连接"
              description="连接 Meta 后，可选择有权管理的 Facebook Page 和已关联的 Instagram 专业账号。"
            />
          </section>
        ) : (
          connections.map((connection) => {
            const connectionReady = connection.status === "CONNECTED";
            const canSelectAccounts = canManageConnections && connectionReady && connection.accounts.length > 0;
            const canRefreshToken = supportsTokenRefresh(connection.provider);
            const connectionNeedsAttention = [
              "TOKEN_EXPIRING",
              "TOKEN_EXPIRED",
              "PERMISSION_MISSING",
              "REVIEW_REQUIRED",
              "ERROR",
            ].includes(connection.status);

            return (
              <section className="section stack" key={connection.id}>
                <SectionHeader
                  title={platformLabel(connection.provider)}
                  description={connection.connectedAt ? `连接于 ${formatDateTime(connection.connectedAt, "—", workspace.timezone)}` : "尚未完成连接"}
                  action={<StatusIndicator value={connection.status} />}
                />

                {connectionNeedsAttention ? (
                  <Notice title="连接需要处理" tone="warning">
                    {connectionRecoveryMessage(connection.status)}
                  </Notice>
                ) : null}

                <div className="detail-section">
                  <div>
                    <h3>已发现账号</h3>
                    <p className="muted">选中需要用于运营的账号，并至少保留一个。只有已连接状态才能修改选择。</p>
                  </div>

                  {connection.accounts.length === 0 ? (
                    <EmptyState
                      title="未发现可管理账号"
                      description="请检查 Meta 授权范围、Page 角色和应用模式后重新连接。"
                    />
                  ) : (
                    <form action={`/api/connections/${connection.id}/select-accounts`} method="post" className="stack">
                      {connection.accounts.map((account) => (
                        <label className="account-option" key={account.id}>
                          <input
                            type="checkbox"
                            name="accountIds"
                            value={account.id}
                            defaultChecked={account.isSelected}
                            disabled={!canSelectAccounts}
                          />
                          <span className="stack-tight">
                            <span>
                              <strong>{account.displayName}</strong>
                              <span className="cell-meta">
                                {accountTypeLabel(account.accountType, account.platform)}
                                {account.username ? ` · @${account.username.replace(/^@/, "")}` : ""}
                              </span>
                            </span>
                            <span className="row">
                              <StatusIndicator
                                value={account.publishCapability}
                                label={`发布：${statusLabel(account.publishCapability)}`}
                                compact
                              />
                              <StatusIndicator
                                value={account.metricsCapability}
                                label={`指标：${statusLabel(account.metricsCapability)}`}
                                compact
                              />
                              <StatusIndicator
                                value={account.commentsCapability}
                                label={`评论：${statusLabel(account.commentsCapability)}`}
                                compact
                              />
                            </span>
                          </span>
                        </label>
                      ))}
                      {!connectionReady ? (
                        <Notice tone="warning">请先重新连接 {platformLabel(connection.provider)}，再修改账号选择。</Notice>
                      ) : null}
                      <div className="actions">
                        <Button type="submit" size="sm" disabled={!canSelectAccounts}>保存账号选择</Button>
                      </div>
                    </form>
                  )}
                </div>

                <details className="disclosure">
                  <summary>技术详情</summary>
                  <div className="disclosure-body technical-details">
                    <div className="facts">
                      <strong>授权主体</strong>
                      <span>{connection.externalPrincipalId || "平台未返回"}</span>
                      <span />
                      <strong>Access token 到期</strong>
                      <span>{formatDateTime(connection.accessTokenExpiresAt, "平台未返回", workspace.timezone)}</span>
                      <span />
                      <strong>最近刷新</strong>
                      <span>{formatDateTime(connection.lastRefreshedAt, "—", workspace.timezone)}</span>
                      <span />
                      <strong>Scopes</strong>
                      <span>{connection.scopes.join(", ") || "未读取"}</span>
                      <span />
                      {connection.lastErrorCode ? (
                        <>
                          <strong>错误代码</strong>
                          <span>{connection.lastErrorCode}</span>
                          <span />
                        </>
                      ) : null}
                      {connection.lastErrorMessage ? (
                        <>
                          <strong>错误详情</strong>
                          <span>{connection.lastErrorMessage}</span>
                          <span />
                        </>
                      ) : null}
                    </div>
                  </div>
                </details>

                <details className="disclosure">
                  <summary>管理连接</summary>
                  <div className="disclosure-body stack">
                    <div className="stack-tight">
                      <h3>刷新授权</h3>
                      {canRefreshToken ? (
                        <>
                          <p className="muted">当前平台支持使用 refresh token 更新授权。</p>
                          <form action={`/api/connections/${connection.id}/refresh`} method="post">
                            <Button
                              type="submit"
                              variant="secondary"
                              size="sm"
                              disabled={!canManageConnections || connection.status === "DISCONNECTED"}
                            >
                              刷新授权
                            </Button>
                          </form>
                        </>
                      ) : (
                        <Notice title="当前平台不支持刷新授权">
                          {platformLabel(connection.provider)} 不提供可用的 refresh token。授权到期或需要更新权限时，请使用页面顶部的“重新连接 {platformLabel(connection.provider)}”。
                        </Notice>
                      )}
                    </div>

                    <div className="danger-zone stack-tight">
                      <h3>危险区域</h3>
                      <p>
                        断开后会尝试撤销远端授权，并清除本地保存的连接凭据。已发布内容和历史记录不会被删除；远端撤销结果可能需要在 Meta 后台确认。
                      </p>
                      <form action={`/api/connections/${connection.id}/disconnect`} method="post" className="stack-tight">
                        <label className="account-option" htmlFor={`confirm-disconnect-${connection.id}`}>
                          <input
                            id={`confirm-disconnect-${connection.id}`}
                            type="checkbox"
                            name="confirmDisconnect"
                            value="yes"
                            required
                            disabled={!canManageConnections || connection.status === "DISCONNECTED"}
                          />
                          <span>
                            <strong>确认断开并清除本地凭据</strong>
                            <span className="cell-meta">我理解远端授权撤销结果仍可能需要在 Meta 后台确认。</span>
                          </span>
                        </label>
                        <Button
                          type="submit"
                          variant="danger"
                          size="sm"
                          disabled={!canManageConnections || connection.status === "DISCONNECTED"}
                        >
                          断开 {platformLabel(connection.provider)} 连接
                        </Button>
                      </form>
                    </div>
                  </div>
                </details>
              </section>
            );
          })
        )}

        <section className="section">
          <SectionHeader
            title="其他平台"
            description="以下连接尚未开放，完成接入后才会启用对应能力。"
          />
          <div className="list">
            <div className="structured-row toolbar">
              <div>
                <strong>LinkedIn</strong>
                <span className="cell-meta">发布和数据同步尚未接入</span>
              </div>
              <StatusIndicator label="暂不可用" tone="neutral" />
            </div>
            <div className="structured-row toolbar">
              <div>
                <strong>TikTok</strong>
                <span className="cell-meta">发布和数据同步尚未接入</span>
              </div>
              <StatusIndicator label="暂不可用" tone="neutral" />
            </div>
          </div>
        </section>

        <Notice title="当前能力范围">
          Meta 已支持授权、Facebook Page 与关联 Instagram 账号发现，以及 Facebook Page 发布和数据同步。Instagram 发布、自动回复和私信仍未开放。
        </Notice>
      </div>
    </OperatorShell>
  );
}
