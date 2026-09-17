import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function DashboardPage() {
  const context = await requirePageContext();
  const [leads, urgent, reviewCount, tasks, jobs, accounts] = await Promise.all([
    db.lead.findMany({ where: { clientId: context.clientId, handoffStatus: { in: ["NEW", "WAITING_FEEDBACK"] } }, include: { interaction: true }, orderBy: { createdAt: "desc" }, take: 5 }),
    db.inAppNotification.findMany({ where: { clientId: context.clientId, severity: "URGENT", readAt: null }, orderBy: { createdAt: "desc" }, take: 5 }),
    db.contentItem.count({ where: { clientId: context.clientId, status: "REVIEW_PENDING" } }),
    db.manualTask.findMany({ where: { clientId: context.clientId, status: { in: ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] } }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 8 }),
    db.publishJob.findMany({ where: { clientId: context.clientId }, orderBy: { updatedAt: "desc" }, take: 8, include: { account: true } }),
    db.socialAccount.findMany({ where: { clientId: context.clientId } }),
  ]);
  const connectionGaps = accounts.filter((account) => account.publishCapability !== "VERIFIED").length;
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>工作台</h1><p className="muted">只展示已保存的事实、任务和执行状态。</p></div></div>
      <div className="grid">
        <section className="card span-3"><span className="muted">重要线索</span><div className="metric">{leads.length}</div></section>
        <section className="card span-3"><span className="muted">故障与连接缺口</span><div className="metric">{urgent.length + connectionGaps}</div></section>
        <section className="card span-3"><span className="muted">待审核</span><div className="metric">{reviewCount}</div></section>
        <section className="card span-3"><span className="muted">人工任务</span><div className="metric">{tasks.length}</div></section>

        <section className="card span-6"><h2>重要线索</h2><div className="list">
          {leads.length === 0 && <p className="muted">暂无明确采购意向。</p>}
          {leads.map((lead) => <article key={lead.id} className="list-item"><div className="row"><span className="badge urgent">{lead.priority}</span><strong>{lead.category}</strong></div><p>{lead.interaction.body}</p><small className="muted">{lead.rationale} · {lead.handoffStatus}</small></article>)}
        </div></section>
        <section className="card span-6"><h2>紧急通知与故障</h2><div className="list">
          {urgent.length === 0 && <p className="muted">暂无未读紧急通知。</p>}
          {urgent.map((notice) => <article key={notice.id} className="list-item"><strong>{notice.title}</strong><p>{notice.body}</p></article>)}
          {connectionGaps > 0 && <div className="warning">{connectionGaps} 个账号的发布能力尚未验证；系统不会伪装为已连接。</div>}
        </div></section>

        <section className="card span-8"><h2>人工任务</h2><div className="list">
          {tasks.map((task) => <article key={task.id} className="list-item stack"><div className="row"><span className={`badge ${task.priority === "URGENT" ? "urgent" : ""}`}>{task.priority}</span><strong>{task.triggerReason}</strong></div><div><b>执行：</b>{task.requiredAction}</div><div><b>完成条件：</b>{task.completionCriteria}</div><div><b>之后继续：</b>{task.continuationStep}</div><form action={`/api/tasks/${task.id}`} method="post" className="row"><select name="status" defaultValue={task.status}><option value="TODO">待处理</option><option value="IN_PROGRESS">处理中</option><option value="WAITING_EXTERNAL">等待外部信息</option><option value="COMPLETED">已完成</option><option value="CANCELLED">取消</option></select><button>更新任务</button></form></article>)}
        </div></section>
        <section className="card span-4"><h2>最近任务运行</h2><div className="list">
          {jobs.length === 0 && <p className="muted">尚无发布任务。</p>}
          {jobs.map((job) => <article key={job.id} className="list-item"><div className="row"><strong>{job.account.platform}</strong><span className={`badge ${job.environment === "SIMULATED" ? "mock" : "ok"}`}>{job.environment}</span></div><p>{job.status}</p><small className="muted">尝试 {job.attemptCount}/{job.maxAttempts}{job.lastErrorCode ? ` · ${job.lastErrorCode}` : ""}</small>{job.environment === "LIVE" && job.remotePostId && <form action={`/api/publish-jobs/${job.id}/query`} method="post"><button className="secondary">查询远端状态</button></form>}{job.status === "UNKNOWN" && <form action={`/api/publish-jobs/${job.id}/reconcile`} method="post" className="stack"><select name="outcome" defaultValue="KEEP_UNKNOWN"><option value="KEEP_UNKNOWN">仍无法确认</option><option value="PUBLISHED">远端确认已发布</option><option value="FAILED">远端确认失败</option></select><input name="remotePostId" placeholder="成功时填写远端帖子 ID" /><input name="remotePostUrl" placeholder="远端帖子链接（可选）" /><textarea name="note" required placeholder="对账证据或失败原因" /><button>保存对账结果</button></form>}</article>)}
        </div></section>
      </div>
    </OperatorShell>
  );
}
