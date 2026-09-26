import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, platformLabel, statusLabel } from "@/lib/presentation/status";

const OPEN_TASK_STATUSES = ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] as const;
const ATTENTION_JOB_STATUSES = ["UNKNOWN", "FAILED", "WAITING_CONFIGURATION"] as const;
const ATTENTION_CONNECTION_STATUSES = ["TOKEN_EXPIRING", "TOKEN_EXPIRED", "PERMISSION_MISSING", "REVIEW_REQUIRED", "ERROR"] as const;

function preview(value: string, maxLength = 96) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export default async function DashboardPage() {
  const context = await requirePageContext();
  const readOnly = context.role === "VIEWER";
  const [
    reviewCount,
    scheduledCount,
    newLeadCount,
    openTaskCount,
    connectionAttentionCount,
    connectionIssueCount,
    attentionJobCount,
    urgentNotificationCount,
    attentionJobs,
    openTasks,
    urgentNotifications,
    accounts,
    jobs,
    leads,
    workspace,
  ] = await Promise.all([
    db.contentItem.count({ where: { clientId: context.clientId, status: "REVIEW_PENDING" } }),
    db.contentItem.count({ where: { clientId: context.clientId, status: "SCHEDULED" } }),
    db.lead.count({ where: { clientId: context.clientId, handoffStatus: "NEW" } }),
    db.manualTask.count({
      where: { clientId: context.clientId, status: { in: [...OPEN_TASK_STATUSES] } },
    }),
    db.socialAccount.count({
      where: { clientId: context.clientId, isSelected: true, publishCapability: { not: "VERIFIED" } },
    }),
    db.platformConnection.count({
      where: { clientId: context.clientId, status: { in: [...ATTENTION_CONNECTION_STATUSES] } },
    }),
    db.publishJob.count({
      where: { clientId: context.clientId, status: { in: [...ATTENTION_JOB_STATUSES] } },
    }),
    db.inAppNotification.count({
      where: { clientId: context.clientId, severity: "URGENT", readAt: null },
    }),
    db.publishJob.findMany({
      where: { clientId: context.clientId, status: { in: [...ATTENTION_JOB_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: {
        account: { select: { id: true, platform: true, displayName: true } },
        contentVersion: { select: { title: true, text: true, item: { select: { plan: { select: { theme: true } } } } } },
      },
    }),
    db.manualTask.findMany({
      where: { clientId: context.clientId, status: { in: [...OPEN_TASK_STATUSES] } },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 8,
    }),
    db.inAppNotification.findMany({
      where: { clientId: context.clientId, severity: "URGENT", readAt: null },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
    db.socialAccount.findMany({
      where: { clientId: context.clientId, isSelected: true },
      orderBy: [{ platform: "asc" }, { displayName: "asc" }],
      select: {
        id: true,
        platform: true,
        displayName: true,
        publishCapability: true,
        platformConnection: { select: { status: true } },
      },
    }),
    db.publishJob.findMany({
      where: { clientId: context.clientId },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: {
        account: { select: { id: true, platform: true, displayName: true } },
        contentVersion: { select: { title: true, text: true, item: { select: { plan: { select: { theme: true } } } } } },
      },
    }),
    db.lead.findMany({
      where: { clientId: context.clientId, handoffStatus: { in: ["NEW", "WAITING_FEEDBACK"] } },
      include: { interaction: { include: { account: { select: { displayName: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);

  const connectionHealthIssueCount = connectionAttentionCount + connectionIssueCount;
  const attentionCount = attentionJobCount + openTaskCount + urgentNotificationCount + connectionHealthIssueCount;
  const hasAttention = attentionCount > 0;

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader title="总览" description="查看内容、发布、连接与线索的最新运行状态。" />

        <section aria-labelledby="operational-summary-title">
          <h2 className="eyebrow" id="operational-summary-title">运营概览</h2>
          <div className="summary-strip">
            <div className="summary-item"><span>待人工审核</span><strong>{reviewCount}</strong></div>
            <div className="summary-item"><span>已排期</span><strong>{scheduledCount}</strong></div>
            <div className="summary-item"><span>新线索</span><strong>{newLeadCount}</strong></div>
            <div className="summary-item"><span>需处理</span><strong>{attentionCount}</strong></div>
          </div>
        </section>

        <div className="split-layout">
          <section className="panel" id="attention" aria-label="需处理">
            <SectionHeader title="需处理" description="优先处理结果待确认的发布、紧急任务和连接问题。" />
            {!hasAttention ? (
              <EmptyState title="没有需要立即处理的问题" description="发布任务、平台连接和紧急任务目前均无异常。" />
            ) : (
              <div className="list">
                {attentionJobs.map((job) => {
                  const contentTitle = job.contentVersion.title?.trim() || job.contentVersion.item.plan.theme;
                  const isUnknown = job.status === "UNKNOWN";
                  return (
                    <article className="list-item stack-tight" key={job.id}>
                      <div className="toolbar">
                        <div className="stack-tight">
                          <StatusIndicator value={job.status} />
                          <strong>{contentTitle}</strong>
                        </div>
                        <span className="cell-meta">{platformLabel(job.account.platform)} · {job.account.displayName}</span>
                      </div>
                      {isUnknown ? (
                        <Notice title="发布结果待确认" tone="warning">
                          平台可能已经收到发布请求。为避免重复发布，系统不会自动重试。
                        </Notice>
                      ) : (
                        <p className="muted">{job.status === "FAILED" ? "发布未完成，请根据任务记录确认下一步。" : "发布连接需要完成配置后才能继续。"}</p>
                      )}
                      {job.environment === "LIVE" && job.remotePostId ? (
                        <div className="actions">
                          <form action={`/api/publish-jobs/${job.id}/query`} method="post">
                            <Button type="submit" variant="secondary" size="sm" disabled={readOnly}>查询平台状态</Button>
                          </form>
                        </div>
                      ) : null}
                      {isUnknown ? (
                        <details className="disclosure">
                          <summary>人工对账</summary>
                          <form action={`/api/publish-jobs/${job.id}/reconcile`} method="post" className="disclosure-body form-stack">
                            <FormField label="确认结果" htmlFor={`reconcile-outcome-${job.id}`}>
                              <select id={`reconcile-outcome-${job.id}`} name="outcome" defaultValue="" required disabled={readOnly}>
                                <option value="">请选择确认结果</option>
                                <option value="PUBLISHED">确认已发布</option>
                                <option value="FAILED">确认失败</option>
                              </select>
                            </FormField>
                            <div className="form-grid">
                              <FormField label="远端帖子 ID" htmlFor={`reconcile-post-id-${job.id}`} helper="确认已发布时必须填写。">
                                <input id={`reconcile-post-id-${job.id}`} name="remotePostId" disabled={readOnly} />
                              </FormField>
                              <FormField label="远端帖子链接" htmlFor={`reconcile-post-url-${job.id}`} helper="可选。">
                                <input id={`reconcile-post-url-${job.id}`} name="remotePostUrl" type="url" disabled={readOnly} />
                              </FormField>
                            </div>
                            <FormField label="对账证据或失败原因" htmlFor={`reconcile-note-${job.id}`}>
                              <textarea id={`reconcile-note-${job.id}`} name="note" required disabled={readOnly} />
                            </FormField>
                            <p className="field-helper">如果仍无法确认，请关闭此面板并保持任务待确认；系统不会自动重试。</p>
                            <div><Button type="submit" size="sm" disabled={readOnly}>提交确认结果</Button></div>
                          </form>
                        </details>
                      ) : null}
                      {job.lastErrorCode ? (
                        <details className="technical-details">
                          <summary>技术详情</summary>
                          <p><code>{job.lastErrorCode}</code>{job.lastErrorMessage ? ` · ${job.lastErrorMessage}` : ""}</p>
                        </details>
                      ) : null}
                    </article>
                  );
                })}

                {openTasks.map((task) => (
                  <details className="disclosure list-item" key={task.id}>
                    <summary>
                      <span className="row"><StatusIndicator value={task.priority} compact /><span>{task.triggerReason}</span></span>
                    </summary>
                    <div className="disclosure-body stack-tight">
                      <p><strong>执行：</strong>{task.requiredAction}</p>
                      <p><strong>完成条件：</strong>{task.completionCriteria}</p>
                      <p><strong>之后继续：</strong>{task.continuationStep}</p>
                      <form action={`/api/tasks/${task.id}`} method="post" className="row">
                        <label htmlFor={`task-status-${task.id}`}>任务状态</label>
                        <select id={`task-status-${task.id}`} name="status" defaultValue={task.status} disabled={readOnly}>
                          <option value="TODO">待处理</option>
                          <option value="IN_PROGRESS">处理中</option>
                          <option value="WAITING_EXTERNAL">等待外部信息</option>
                          <option value="COMPLETED">已完成</option>
                          <option value="CANCELLED">取消</option>
                        </select>
                        <Button type="submit" size="sm" disabled={readOnly}>更新任务</Button>
                      </form>
                    </div>
                  </details>
                ))}

                {urgentNotifications.map((notice) => (
                  <article className="list-item stack-tight" key={notice.id}>
                    <StatusIndicator value="URGENT" compact />
                    <strong>{notice.title}</strong>
                    <p className="muted">{notice.body}</p>
                  </article>
                ))}

                {connectionHealthIssueCount > 0 ? (
                  <Notice title={`${connectionHealthIssueCount} 项连接或账号能力需要检查`} tone="warning">
                    <span>完成授权和能力验证后，相关发布功能才会启用。 <a className="text-link" href="/accounts">查看平台与账号</a></span>
                  </Notice>
                ) : null}
              </div>
            )}
          </section>

          <section className="panel" aria-label="平台连接">
            <SectionHeader title="平台与账号" description="当前工作区已启用账号的发布能力。" action={<a className="text-link" href="/accounts">管理账号</a>} />
            {accounts.length === 0 ? (
              <EmptyState title="尚未启用平台账号" description="连接并选择账号后，平台状态会显示在这里。" />
            ) : (
              <div className="list">
                {accounts.map((account) => {
                  const capabilityLabel = account.publishCapability === "VERIFIED"
                    ? "发布可用"
                    : account.publishCapability === "UNSUPPORTED"
                      ? "暂不支持发布"
                      : account.publishCapability === "UNVERIFIED"
                        ? "发布待验证"
                        : "发布未配置";
                  return (
                    <div className="list-item toolbar" key={account.id}>
                      <div>
                        <strong>{platformLabel(account.platform)}</strong>
                        <span className="cell-meta">{account.displayName}</span>
                      </div>
                      <div className="stack-tight">
                        {account.platformConnection ? <StatusIndicator value={account.platformConnection.status} compact /> : null}
                        <StatusIndicator value={account.publishCapability} label={capabilityLabel} compact />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <section className="panel" aria-label="近期发布">
          <SectionHeader title="近期发布" description="最近更新的发布任务与远端状态。" action={<a className="text-link" href="/publishing">查看发布中心</a>} />
          {jobs.length === 0 ? (
            <EmptyState title="还没有发布记录" description="内容完成审核并排期后，发布活动会显示在这里。" />
          ) : (
            <div className="table-scroll" role="region" aria-label="近期发布" tabIndex={0}>
              <table>
                <thead><tr><th>状态</th><th>渠道与账号</th><th>内容</th><th>环境</th><th>更新时间</th></tr></thead>
                <tbody>
                  {jobs.map((job) => {
                    const contentTitle = job.contentVersion.title?.trim() || job.contentVersion.item.plan.theme;
                    return (
                      <tr key={job.id}>
                        <td><StatusIndicator value={job.status} compact /></td>
                        <td><span className="cell-title">{platformLabel(job.account.platform)}</span><span className="cell-meta">{job.account.displayName}</span></td>
                        <td><span className="cell-title">{contentTitle}</span><span className="cell-meta">{preview(job.contentVersion.text)}</span></td>
                        <td><StatusIndicator value={job.environment} compact /></td>
                        <td className="number">{formatDateTime(job.updatedAt, "—", workspace.timezone)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel" aria-label="近期线索">
          <SectionHeader title="待跟进线索" description="最新的新线索与等待反馈事项。" action={<a className="text-link" href="/insights">查看线索与数据</a>} />
          {leads.length === 0 ? (
            <EmptyState title="还没有新线索" description="识别到明确采购意向后，线索会显示在这里。" />
          ) : (
            <div className="table-scroll" role="region" aria-label="待跟进线索" tabIndex={0}>
              <table>
                <thead><tr><th>优先级</th><th>线索</th><th>意图</th><th>来源</th><th>状态</th><th>收到时间</th></tr></thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td><StatusIndicator value={lead.priority} compact /></td>
                      <td><span className="cell-title">{preview(lead.interaction.body, 120)}</span><span className="cell-meta">{lead.rationale}</span></td>
                      <td>{statusLabel(lead.category)}</td>
                      <td><span className="cell-title">{platformLabel(lead.interaction.platform)}</span><span className="cell-meta">{lead.interaction.account?.displayName || lead.interaction.authorDisplay || lead.interaction.authorHandle || "来源账号未记录"}</span></td>
                      <td><StatusIndicator value={lead.handoffStatus} compact /></td>
                      <td className="number">{formatDateTime(lead.createdAt, "—", workspace.timezone)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </OperatorShell>
  );
}
