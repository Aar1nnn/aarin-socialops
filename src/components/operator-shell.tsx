import Link from "next/link";
import type { RequestContext } from "@/lib/context";
import { db } from "@/lib/db";

export async function OperatorShell({ context, children }: { context: RequestContext; children: React.ReactNode }) {
  const [client, memberships] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.clientMembership.findMany({ where: { userId: context.userId }, include: { client: true } }),
  ]);
  const modeName = { DEMO: "演示模式", DRAFT: "草稿模式", LIVE: "正式模式" }[client.mode];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">海外社媒 AI<br />运营工作台</div>
        <span className="mode">{modeName}</span>
        <p>{client.name}</p>
        <nav>
          <Link href="/">工作台</Link>
          <Link href="/products">产品与素材</Link>
          <Link href="/content">内容审核</Link>
          <Link href="/connections">平台连接</Link>
          <Link href="/insights">线索与复盘</Link>
          <Link href="/settings">设置</Link>
        </nav>
        {memberships.length > 1 && (
          <form action="/api/auth/switch-client" method="post" className="stack">
            <select name="clientId" defaultValue={context.clientId} aria-label="切换客户">
              {memberships.map(({ client: option }) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            <button type="submit" className="secondary">切换客户</button>
          </form>
        )}
        <form action="/api/auth/logout" method="post" style={{ marginTop: "1rem" }}>
          <button type="submit" className="secondary">退出登录</button>
        </form>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
