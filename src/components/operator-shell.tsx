import type { RequestContext } from "@/lib/context";
import { db } from "@/lib/db";
import { PrimaryNav } from "@/components/primary-nav";
import { StatusIndicator } from "@/components/ui";

export async function OperatorShell({ context, children }: { context: RequestContext; children: React.ReactNode }) {
  const [client, memberships] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.clientMembership.findMany({ where: { userId: context.userId }, include: { client: true } }),
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
          {memberships.length > 1 ? (
            <form action="/api/auth/switch-client" method="post" className="workspace-switcher">
              <label htmlFor="workspace-client">切换工作区</label>
              <div className="workspace-switcher-controls">
                <select id="workspace-client" name="clientId" defaultValue={context.clientId}>
                  {memberships.map(({ client: option }) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
                <button type="submit" className="button button-ghost button-sm">切换</button>
              </div>
            </form>
          ) : null}
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
      <main className="main" id="main-content">{children}</main>
    </div>
  );
}
