import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function NotificationsPage() {
  const context = await requirePageContext();
  const [channels, notifications] = await Promise.all([
    db.notificationChannel.findMany({ where: { clientId: context.clientId }, orderBy: { updatedAt: "desc" } }),
    db.inAppNotification.findMany({ where: { clientId: context.clientId }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>通知</h1><p className="muted">站内事件先持久化；Webhook/Email 失败不会回滚主业务事务。</p></div></div>
      <div className="grid">
        <section className="card span-5"><h2>新增轻量通道</h2><form action="/api/notifications/channels" method="post" className="stack"><label>类型<select name="type"><option value="WEBHOOK">Webhook</option><option value="EMAIL">Email gateway</option></select></label><label>名称<input name="displayName" required /></label><label>HTTP endpoint<input type="url" name="endpoint" required /></label><label>Email 收件人（仅 Email）<input type="email" name="recipient" /></label><label>凭据引用（可选）<input name="credentialRef" placeholder="env:NOTIFICATION_GATEWAY_TOKEN" /></label><p className="muted">Endpoint 不应包含秘密；Bearer 凭据只通过服务器环境变量引用。</p><button>保存为待验证</button></form></section>
        <section className="card span-7"><h2>通道状态</h2><div className="list">{channels.map((channel) => <article className="list-item stack" key={channel.id}><div className="row"><strong>{channel.displayName}</strong><span className="badge">{channel.type}</span><span className={`badge ${channel.status === "VERIFIED" ? "ok" : ""}`}>{channel.status}</span></div><small className="muted">最后派发：{channel.lastDispatchAt?.toLocaleString("zh-CN") || "—"}</small>{channel.lastError && <div className="error">{channel.lastError}</div>}{["WEBHOOK", "EMAIL"].includes(channel.type) && <form action={`/api/notifications/channels/${channel.id}/verify`} method="post"><button className="secondary">发送验证事件</button></form>}</article>)}</div></section>
        <section className="card span-12"><h2>最近站内事件</h2><div className="list">{notifications.map((notice) => <article key={notice.id} className="list-item"><div className="row"><span className={`badge ${notice.severity === "URGENT" ? "urgent" : ""}`}>{notice.severity}</span><strong>{notice.title}</strong></div><p>{notice.body}</p><small className="muted">{notice.relatedType || "GENERAL"} · {notice.createdAt.toLocaleString("zh-CN")}</small></article>)}</div></section>
      </div>
    </OperatorShell>
  );
}
