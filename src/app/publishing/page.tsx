import { PublishJobStatus } from "@prisma/client";
import { OperatorShell } from "@/components/operator-shell";
import { PublishingActionForm } from "@/components/publishing-action-form";
import { EmptyState, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { canWrite } from "@/lib/context";
import { db } from "@/lib/db";
import { resolveAccountPublishingMode } from "@/lib/manual-account";
import { PUBLISHING_LANES, publishingStatusLabel, safeRemotePostUrl } from "@/lib/presentation/publishing";
import { formatDateTime, platformLabel, statusLabel } from "@/lib/presentation/status";
import { getPlatformRegistry } from "@/services/platform-registry-service";

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nextAction(status: PublishJobStatus, manual: boolean) {
  if (status === "MANUAL_PENDING") return "到目标平台人工发布获批内容；完成后记录实际时间、URL 与证据。";
  if (status === "PENDING") return "等待 worker 到达排期时间；无需人工重复发送。";
  if (status === "RUNNING") return "发布执行中；不要同时手动发送。";
  if (status === "RETRY") return "系统会按既有安全策略自动重试；不要人工重复发送。";
  if (status === "WAITING_CONFIGURATION") return "检查账号连接、权限和发布能力；本页面不恢复执行，请处理配置并重新走内容审核与排期。";
  if (status === "UNKNOWN") return manual
    ? "人工结果不确定；禁止再次发布，先在平台核实，再记录确认结果。"
    : "远端结果不确定；禁止普通重试，先远端查询或人工对账。";
  if (status === "FAILED") return manual
    ? "已确认没有创建外部帖子；如需再次发布，创建新版本并重新人工批准。"
    : "任务已终结；本页面不提供直接重试，请查明原因并创建新批准版本。";
  if (status === "PUBLISHED") return manual ? "人工发布已确认；查看记录的外部帖子与证据。" : "发布成功；查看远端帖子。";
  return "任务已取消；检查内容版本和批准状态。";
}

export default async function PublishingPage({ searchParams }: { searchParams: Promise<{ status?: string; lane?: string }> }) {
  const context = await requirePageContext();
  const query = await searchParams;
  const status = Object.values(PublishJobStatus).includes(query.status as PublishJobStatus)
    ? query.status as PublishJobStatus : null;
  const selectedLane = status ? null : PUBLISHING_LANES.find((lane) => lane.key === query.lane) ?? null;
  const [counts, jobs, workspace] = await Promise.all([
    db.publishJob.groupBy({ by: ["status"], where: { clientId: context.clientId }, _count: { _all: true } }),
    db.publishJob.findMany({
      where: { clientId: context.clientId, ...(status ? { status } : selectedLane ? { status: { in: selectedLane.statuses } } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 60,
      include: {
        account: { include: { platformConnection: { select: { status: true } } } },
        contentVersion: { select: { id: true, title: true, item: { select: { id: true, plan: { select: { theme: true } } } } } },
        attempts: { orderBy: { number: "desc" } },
        manualTasks: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  const manualJobIds = jobs.filter((job) => job.adapter === "manual").map((job) => job.id);
  const manualAudits = manualJobIds.length ? await db.auditLog.findMany({
    where: { clientId: context.clientId, entityType: "PublishJob", entityId: { in: manualJobIds }, action: "MANUAL_PUBLISH_RESULT_RECORDED" },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { displayName: true } } },
  }) : [];
  const latestManualAudit = new Map<string, (typeof manualAudits)[number]>();
  for (const audit of manualAudits) if (audit.entityId && !latestManualAudit.has(audit.entityId)) latestManualAudit.set(audit.entityId, audit);
  const countByStatus = new Map(counts.map((entry) => [entry.status, entry._count._all]));
  const writable = canWrite(context.role);

  return <OperatorShell context={context}><div className="page">
    <PageHeader title="发布中心" description="查看 API 与人工发布任务、证据和异常；所有真实发布仍须对应有效人工批准。" />
    <div className="publishing-summary" aria-label="发布状态汇总">
      {PUBLISHING_LANES.map((lane) => <a className="publishing-summary-item" href={`/publishing?lane=${lane.key}`} key={lane.key}>
        <span>{lane.label}</span><strong>{lane.statuses.reduce((total, value) => total + (countByStatus.get(value) ?? 0), 0)}</strong>
      </a>)}
    </div>
    <Notice title="结果待确认不能重试" tone="warning">UNKNOWN 表示外部是否已收到发布尚不确定。先查询或人工核实，再对账；不得直接再次发布。</Notice>
    <section className="panel">
      <SectionHeader title="发布任务" description="按最近更新时间展示最多 60 条；可按任务状态筛选。" />
      {selectedLane ? <p>当前分组：{selectedLane.label} · <a className="text-link" href="/publishing">清除分组筛选</a></p> : null}
      <form method="get" className="row"><label>状态 <select name="status" defaultValue={status ?? ""}><option value="">全部</option>{Object.values(PublishJobStatus).map((value) => <option key={value} value={value}>{publishingStatusLabel(value) || statusLabel(value)}</option>)}</select></label><button type="submit">应用筛选</button></form>
      {jobs.length === 0 ? <EmptyState title="没有符合条件的发布任务" description="内容获有效人工批准并完成排期后，任务会出现在这里。" action={<a className="text-link" href="/content">查看内容中心</a>} /> : null}
    </section>
    <div className="stack">{jobs.map((job) => {
      const manual = job.adapter === "manual" && resolveAccountPublishingMode(job.account) === "MANUAL";
      const title = job.contentVersion.title?.trim() || job.contentVersion.item.plan.theme;
      const remoteUrl = safeRemotePostUrl(job.remotePostUrl);
      const audit = latestManualAudit.get(job.id);
      const evidence = metadataRecord(audit?.metadata);
      const canQuery = !manual && job.status === "UNKNOWN" && Boolean(job.remotePostId)
        && Boolean(getPlatformRegistry().getByPlatform(job.account.platform)?.definition.capabilities.includes("STATUS_QUERY"));
      return <details className="panel" key={job.id} id={job.id}>
        <summary className="row"><StatusIndicator value={job.status} label={publishingStatusLabel(job.status)} compact /><strong>{title}</strong><span>{platformLabel(job.account.platform)} · {job.account.displayName}</span><span>{manual ? "人工发布" : job.simulated ? "模拟 API" : "API 发布"}</span></summary>
        <div className="stack">
          <p><a className="text-link" href={`/content/${job.contentVersion.item.id}`}>查看获批内容</a> · 计划时间：{formatDateTime(job.nextAttemptAt, "—", workspace.timezone)} · 环境：{job.environment}</p>
          <p>下一步：{nextAction(job.status, manual)}</p>
          <p className="cell-meta">账号连接：{manual ? "人工管理，无 API 连接" : job.account.platformConnection?.status || "未记录平台连接"} · 发布能力：{statusLabel(job.account.publishCapability)} · 指标能力：{statusLabel(job.account.metricsCapability)} · 互动能力：{statusLabel(job.account.commentsCapability)}</p>
          {job.lastErrorCode || job.lastErrorMessage ? <p role="status">原因：{job.lastErrorCode || "—"} · {job.lastErrorMessage || "无详细信息"}</p> : null}
          {remoteUrl ? <p>{job.status === "UNKNOWN" ? "未确认的远端线索：" : "外部帖子："}<a className="text-link" href={remoteUrl} target="_blank" rel="noopener noreferrer">{remoteUrl}</a></p> : null}
          {job.remotePostId ? <p>远端帖子 ID：{job.remotePostId}</p> : null}
          {job.publishedAt ? <p>实际发布时间：{formatDateTime(job.publishedAt, "—", workspace.timezone)}</p> : null}
          {manual ? <p className="cell-meta">人工任务：{job.manualTasks[0] ? statusLabel(job.manualTasks[0].status) : "缺失"}{job.manualTasks[0]?.suggestedDueAt ? ` · 应处理时间：${formatDateTime(job.manualTasks[0].suggestedDueAt, "—", workspace.timezone)}` : ""}</p> : null}
          {audit ? <p>最近人工记录：{audit.user?.displayName || audit.userId || "未知操作人"} · {formatDateTime(audit.createdAt, "—", workspace.timezone)} · 结果 {String(evidence.outcome || "—")} · 证据：{String(evidence.evidence || "—")}</p> : null}
          <div><strong>API 尝试记录</strong>{job.attempts.length ? <ul>{job.attempts.map((attempt) => <li key={attempt.id}>第 {attempt.number} 次 · {statusLabel(attempt.status)} · {formatDateTime(attempt.startedAt, "—", workspace.timezone)}{attempt.errorCode ? ` · ${attempt.errorCode}` : ""}{attempt.errorMessage ? `：${attempt.errorMessage}` : ""}</li>)}</ul> : <p className="cell-meta">{manual ? "人工任务没有 API 发送尝试。" : "尚未发送。"}</p>}</div>
          {writable && manual && (job.status === "MANUAL_PENDING" || job.status === "UNKNOWN") ? <div className="form-grid">
            <PublishingActionForm action={`/api/publish-jobs/${job.id}/manual-result`}>
              <h3>确认人工发布成功</h3><input type="hidden" name="expectedContentVersionId" value={job.contentVersionId} /><input type="hidden" name="expectedJobStatus" value={job.status} /><input type="hidden" name="outcome" value="PUBLISHED" /><input type="hidden" name="timezone" value={workspace.timezone} />
              <label>实际发布时间（{workspace.timezone}）<input type="datetime-local" name="publishedLocalDateTime" required /></label>
              <label>外部帖子 HTTPS URL<input type="url" name="remotePostUrl" required /></label>
              <label>核实证据／说明<textarea name="evidence" required rows={2} /></label><button type="submit">确认人工已发布</button>
            </PublishingActionForm>
            <PublishingActionForm action={`/api/publish-jobs/${job.id}/manual-result`}>
              <h3>确认没有创建外部帖子</h3><input type="hidden" name="expectedContentVersionId" value={job.contentVersionId} /><input type="hidden" name="expectedJobStatus" value={job.status} /><input type="hidden" name="outcome" value="FAILED" />
              <label>核实证据／原因<textarea name="evidence" required rows={2} /></label>
              <label><input type="checkbox" name="confirmedNoExternalPost" required /> 我已确认没有创建任何外部帖子；如不确定，应记录 UNKNOWN。</label><button type="submit">记录明确失败</button>
            </PublishingActionForm>
            {job.status === "MANUAL_PENDING" ? <PublishingActionForm action={`/api/publish-jobs/${job.id}/manual-result`}>
              <h3>结果不确定</h3><input type="hidden" name="expectedContentVersionId" value={job.contentVersionId} /><input type="hidden" name="expectedJobStatus" value={job.status} /><input type="hidden" name="outcome" value="UNKNOWN" />
              <label>现有线索和待核实事项<textarea name="evidence" required rows={2} /></label><button type="submit">标记 UNKNOWN，停止再次发布</button>
            </PublishingActionForm> : null}
          </div> : null}
          {writable && !manual && job.status === "UNKNOWN" ? <div className="form-grid">
            {canQuery ? <PublishingActionForm action={`/api/publish-jobs/${job.id}/query`} className=""><button type="submit">查询远端状态</button></PublishingActionForm> : <p className="cell-meta">没有可用的远端查询条件；请到平台后台人工核实。</p>}
            <PublishingActionForm action={`/api/publish-jobs/${job.id}/reconcile`}>
              <label>核实结果<select name="outcome"><option value="KEEP_UNKNOWN">仍未确认</option><option value="PUBLISHED">确认已发布</option><option value="FAILED">确认未发布</option></select></label>
              <label>远端帖子 ID（确认成功时必填）<input name="remotePostId" /></label>
              <label>远端 HTTPS URL（可选）<input type="url" name="remotePostUrl" /></label>
              <label>核实依据<textarea name="note" required rows={2} /></label><button type="submit">记录对账结果</button>
            </PublishingActionForm>
          </div> : null}
        </div>
      </details>;
    })}</div>
  </div></OperatorShell>;
}
