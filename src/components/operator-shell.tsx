import type { RequestContext } from "@/lib/context";
import { db } from "@/lib/db";
import { PrimaryNav } from "@/components/primary-nav";
import { StatusIndicator } from "@/components/ui";

export async function OperatorShell({ context, children }: { context: RequestContext; children: React.ReactNode }) {
  const [client, memberships, unreadCount, notifications] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.clientMembership.findMany({ where: { userId: context.userId }, include: { client: true } }),
    db.inAppNotification.count({ where: { clientId: context.clientId, readAt: null } }),
    db.inAppNotification.findMany({
      where: { clientId: context.clientId, readAt: null },
      orderBy: { lastOccurredAt: "desc" },
      take: 3,
      select: { id: true, title: true, body: true },
    }),
  ]);
  const activeMembership = memberships.find((membership) => membership.clientId === context.clientId);
  const roleName = { OWNER: "所有者", OPERATOR: "运营者", VIEWER: "只读成员" }[activeMembership?.role ?? context.role];
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand" aria-label="Aarin SocialOps">
            <span>Aarin</span>
            <strong>SocialOps</strong>
          </div>
          <div className="workspace-context">
            <span className="sidebar-label">当前工作区</span>
            <strong title={client.name}>{client.name}</strong>
            <StatusIndicator value={client.mode} compact />
          </div>
        </div>
        <PrimaryNav />
        <div className="sidebar-footer">
          <div className="user-summary">
            <div className="user-avatar" aria-hidden="true">{roleName.slice(0, 1)}</div>
            <div>
              <strong>{roleName}</strong>
              <span>{client.name}</span>
            </div>
          </div>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="button button-ghost button-sm sidebar-logout">退出登录</button>
          </form>
        </div>
      </aside>
      <div className="work-area">
        <header className="operator-toolbar" aria-label="工作区操作">
          <div className="operator-toolbar-context">
            <span>当前工作区</span>
            <strong title={client.name}>{client.name}</strong>
            <StatusIndicator value={client.mode} compact />
            {memberships.length > 1 ? (
              <form action="/api/auth/switch-client" method="post" className="toolbar-workspace-switcher">
                <label htmlFor="workspace-client">切换工作区</label>
                <select id="workspace-client" name="clientId" defaultValue={context.clientId}>
                  {memberships.map(({ client: option }) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
                <button type="submit" className="button button-secondary button-sm">切换</button>
              </form>
            ) : null}
          </div>
          <div className="operator-toolbar-actions">
            {context.role !== "VIEWER" ? (
              <details className="toolbar-menu">
                <summary className="button button-primary button-sm">快捷创建</summary>
                <div className="toolbar-menu-content">
                  <a href="/content?create=1#new-content">创建内容</a>
                  <a href="/products?create=1#create-product">创建产品</a>
                </div>
              </details>
            ) : null}
            <details className="toolbar-menu">
              <summary className="button button-secondary button-sm">通知{unreadCount > 0 ? ` ${unreadCount}` : ""}</summary>
              <div className="toolbar-menu-content notification-preview">
                {notifications.length === 0 ? <p>暂无未读通知。</p> : notifications.map((notification) => (
                  <div className="notification-preview-item" key={notification.id}>
                    <strong>{notification.title}</strong>
                    <p>{notification.body}</p>
                  </div>
                ))}
                <a href="/settings">查看通知设置</a>
              </div>
            </details>
            <span className="toolbar-role">{roleName}</span>
          </div>
        </header>
        <main className="main" id="main-content">{children}</main>
      </div>
    </div>
  );
}
