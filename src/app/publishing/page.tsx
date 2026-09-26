import { OperatorShell } from "@/components/operator-shell";
import { EmptyState, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { PUBLISHING_LANES, publishingStatusLabel, safeRemotePostUrl } from "@/lib/presentation/publishing";
import { formatDateTime, platformLabel } from "@/lib/presentation/status";

export default async function PublishingPage() {
  const context = await requirePageContext();
  const [counts, jobs, workspace] = await Promise.all([
    db.publishJob.groupBy({ by: ["status"], where: { clientId: context.clientId }, _count: { _all: true } }),
    db.publishJob.findMany({
      where: { clientId: context.clientId },
      orderBy: { updatedAt: "desc" },
      take: 60,
      include: {
        account: { select: { platform: true, displayName: true } },
        contentVersion: { select: { title: true, item: { select: { plan: { select: { theme: true } } } } } },
        attempts: { orderBy: { number: "desc" }, take: 1, select: { status: true, startedAt: true, errorMessage: true } },
      },
    }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  const countByStatus = new Map(counts.map((entry) => [entry.status, entry._count._all]));

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader title="发布中心" description="只读查看当前工作区的发布队列、尝试与远端结果；内容与审批仍在内容中心操作。" />
        <div className="publishing-summary" aria-label="发布状态汇总">
          {PUBLISHING_LANES.map((lane) => (
            <div className="publishing-summary-item" key={lane.key}>
              <span>{lane.label}</span>
              <strong>{lane.statuses.reduce((total, status) => total + (countByStatus.get(status) ?? 0), 0)}</strong>
            </div>
          ))}
        </div>
        <Notice title="结果待确认不是发布失败" tone="warning">
          UNKNOWN 表示远端结果尚未确认，不能盲目重发。请到<a className="text-link" href="/content">内容中心</a>查看对应内容与人工对账入口。
        </Notice>
        <section className="panel" aria-label="发布任务">
          <SectionHeader title="发布任务" description="按最近更新时间展示最多 60 条任务；状态及尝试记录直接来自现有 PublishJob / PublishAttempt。" />
          {jobs.length === 0 ? (
            <EmptyState title="还没有发布任务" description="内容获有效人工批准并完成排期后，任务会出现在这里。" action={<a className="text-link" href="/content">查看内容中心</a>} />
          ) : (
            <div className="table-scroll" role="region" aria-label="发布任务列表" tabIndex={0}>
              <table>
                <thead><tr><th>状态</th><th>内容</th><th>平台与账号</th><th>环境</th><th>最近尝试</th><th>更新时间</th><th>远端结果</th></tr></thead>
                <tbody>{jobs.map((job) => {
                  const attempt = job.attempts[0];
                  const title = job.contentVersion.title?.trim() || job.contentVersion.item.plan.theme;
                  const remoteUrl = job.status === "PUBLISHED" ? safeRemotePostUrl(job.remotePostUrl) : null;
                  return (
                    <tr key={job.id}>
                      <td><StatusIndicator value={job.status} label={publishingStatusLabel(job.status)} compact /></td>
                      <td><span className="cell-title">{title}</span></td>
                      <td><span className="cell-title">{platformLabel(job.account.platform)}</span><span className="cell-meta">{job.account.displayName}</span></td>
                      <td><StatusIndicator value={job.environment} compact /></td>
                      <td>{attempt ? <><StatusIndicator value={attempt.status} compact /><span className="cell-meta">{formatDateTime(attempt.startedAt, "—", workspace.timezone)}</span>{attempt.errorMessage ? <span className="cell-meta">{attempt.errorMessage}</span> : null}</> : "尚未执行"}</td>
                      <td className="number">{formatDateTime(job.updatedAt, "—", workspace.timezone)}</td>
                      <td>{remoteUrl ? <a className="text-link" href={remoteUrl} target="_blank" rel="noopener noreferrer">查看已发布内容</a> : job.status === "UNKNOWN" ? "需人工对账" : "—"}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </OperatorShell>
  );
}
