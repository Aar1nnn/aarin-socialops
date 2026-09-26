import { notFound } from "next/navigation";
import { ContentActions } from "@/components/content-actions";
import { OperatorShell } from "@/components/operator-shell";
import { EmptyState, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { safeRemotePostUrl } from "@/lib/presentation/publishing";
import { formatDateTime, platformLabel, statusLabel } from "@/lib/presentation/status";
import { compareContentVersions } from "@/services/content-composition-service";
import { checkContent } from "@/services/content-service";
import { getContentOperationsDetail } from "@/services/content-operations-view";
import { readStrategyProvenance } from "@/services/social-strategy-service";
import { resolveAccountPublishingMode } from "@/lib/manual-account";

type Fact = { key: string; value: string; source: string };
type AIReview = { platform: string; passed: boolean; findings: { severity: string; message: string }[] };

function detailsFromFacts(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const facts: Fact[] = Array.isArray(record.confirmedFacts) ? record.confirmedFacts.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const fact = entry as Record<string, unknown>;
    return typeof fact.key === "string" && typeof fact.value === "string" ? [{ key: fact.key, value: fact.value, source: typeof fact.source === "string" ? fact.source : "未记录来源" }] : [];
  }) : [];
  const missing = Array.isArray(record.missingFields) ? record.missingFields.filter((entry): entry is string => typeof entry === "string") : [];
  const pipeline = record.pipeline && typeof record.pipeline === "object" && !Array.isArray(record.pipeline) ? record.pipeline as Record<string, unknown> : {};
  const reviews: AIReview[] = Array.isArray(pipeline.reviews) ? pipeline.reviews.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const review = entry as Record<string, unknown>;
    if (typeof review.platform !== "string" || typeof review.passed !== "boolean") return [];
    const findings = Array.isArray(review.findings) ? review.findings.flatMap((finding) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) return [];
      const record = finding as Record<string, unknown>;
      return typeof record.message === "string" ? [{ severity: typeof record.severity === "string" ? record.severity : "INFO", message: record.message }] : [];
    }) : [];
    return [{ platform: review.platform, passed: review.passed, findings }];
  }) : [];
  return { facts, missing, reviews };
}

const sourceLabel: Record<string, string> = { SYSTEM: "初始生成", MANUAL: "人工编辑", AUTOSAVE: "草稿保存", RESTORE: "历史恢复", AI_REWRITE: "AI 改写", AI_REGENERATE: "AI 重生成" };

export default async function ContentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ compare?: string | string[] }> }) {
  const context = await requirePageContext();
  const { id } = await params;
  const item = await getContentOperationsDetail(context, id);
  if (!item) notFound();
  const [workspace, issues] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { name: true, mode: true, timezone: true } }),
    checkContent(context, id),
  ]);
  const version = item.currentVersion;
  const strategyProvenance = version ? readStrategyProvenance(version.sourceFacts) : "LEGACY_UNBOUND";
  const sourceFacts = version?.sourceFacts && typeof version.sourceFacts === "object" && !Array.isArray(version.sourceFacts) ? version.sourceFacts : {};
  const factDetails = detailsFromFacts(version?.sourceFacts);
  const approval = version?.approvals[0];
  const approved = Boolean(approval && approval.decision === "APPROVED" && approval.accountId === item.accountId);
  const blockingChecks = issues.filter((entry) => entry.level === "ERROR").map((entry) => entry.message);
  const history = item.versions;
  const query = await searchParams;
  const requestedCompare = Array.isArray(query.compare) ? query.compare[0] : query.compare;
  const before = history.find((entry) => entry.id === requestedCompare && entry.id !== version?.id) || history.find((entry) => entry.id !== version?.id);
  const comparison = before && version ? await compareContentVersions(context, id, before.id, version.id) : null;
  const jobs = history.flatMap((entry) => entry.publishJobs.map((job) => ({ ...job, version: entry.version }))).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const currentJob = version ? jobs.find((job) => job.contentVersionId === version.id && job.accountId === item.accountId) : null;
  const publishingMode = currentJob ? currentJob.adapter === "manual" ? "MANUAL" : "API" : resolveAccountPublishingMode(item.account);
  const comments = history.flatMap((entry) => entry.reviewComments.map((comment) => ({ ...comment, version: entry.version }))).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const nextStep = !version ? "请联系管理员恢复当前版本。" : blockingChecks.length ? "先修复内容检查阻断，再提交审核或排期。" : item.status === "DRAFT" || item.status === "CHANGES_REQUESTED" ? "运营修改当前版本后提交人工审核。" : item.status === "REVIEW_PENDING" ? "等待有编辑权限的成员提出修改或人工批准。" : item.status === "APPROVED" ? approved ? "当前版本已获人工批准，可以排期。" : "当前版本缺少有效批准，请重新提交人工审核。" : item.status === "UNKNOWN" ? "发布结果待确认；不能盲目重试，请人工对账。" : item.status === "SCHEDULED" || item.status === "RUNNING" ? "发布任务已进入队列，请到发布中心查看进展。" : item.status === "PUBLISHED" ? "内容已发布；可查看发布结果与指标。" : "查看发布记录及阻断原因，处理后再进入审核。";
  const title = version?.title?.trim() || item.plan.theme;

  return <OperatorShell context={context}><div className="page content-detail-page">
    <a className="text-link" href="/content">← 返回内容中心</a>
    <PageHeader title={title} eyebrow={`${workspace.name} · ${platformLabel(item.platform)} · ${item.account.displayName}`} description={`当前 v${version?.version ?? "—"} · ${item.plan.product?.name || "未关联产品"}`} action={<StatusIndicator value={item.status} />} />
    <div className="content-detail-summary"><div><span>当前版本</span><strong>v{version?.version ?? "—"}</strong></div><div><span>人工审核</span><strong>{approved ? "当前版本已批准" : item.status === "REVIEW_PENDING" ? "待人工审核" : "当前版本未批准"}</strong></div><div><span>排期</span><strong>{formatDateTime(item.scheduledAt, "未排期", workspace.timezone)}</strong></div><div><span>下一步</span><strong>{nextStep}</strong></div></div>
    <Notice title="AI 检查不等于人工批准">AI 检查只是风险提示；只有绑定当前 ContentVersion 和目标账号的人工 Approval 才能进入排期。</Notice>
    <Notice title="策略依据">{strategyProvenance}{typeof sourceFacts.socialStrategyVersion === "number" ? ` · 策略 v${sourceFacts.socialStrategyVersion}` : ""}{typeof sourceFacts.socialStrategyStatus === "string" ? ` · ${sourceFacts.socialStrategyStatus}` : ""}。历史缺失字段按 LEGACY_UNBOUND 解释，不会自动绑定最新策略。</Notice>
    <div className="content-detail-grid"><div className="content-detail-main">
      <section className="panel content-detail-panel"><SectionHeader title="当前平台版本" description={`v${version?.version ?? "—"} · ${version?.generationLabel || "—"} · ${formatDateTime(version?.createdAt, "—", workspace.timezone)}`} action={version?.simulated ? <StatusIndicator value="SIMULATED" compact /> : null} />
        {version ? <div className="content-copy"><h3>{version.title || item.plan.theme}</h3><p>{version.text}</p></div> : <Notice title="当前版本缺失" tone="danger">请联系管理员检查内容记录。</Notice>}
      </section>
      <section className="panel content-detail-panel"><SectionHeader title="版本历史与差异" description="所有保存、改写和恢复都会创建不可变版本；旧批准不会自动继承。" />
        <div className="content-version-list">{history.map((entry) => <div className="content-version-entry" key={entry.id}><a href={`/content/${id}?compare=${entry.id}#version-diff`} className={entry.id === version?.id ? "current" : undefined}><strong>v{entry.version}</strong><span>{sourceLabel[entry.source] || "内容版本"}</span><span>{formatDateTime(entry.createdAt, "—", workspace.timezone)}</span><span>{entry.approvals.some((decision) => decision.decision === "APPROVED") ? "有历史批准" : "无批准"}</span></a>{entry.id !== version?.id && entry.approvals.length ? <p className="cell-meta">历史审核：{entry.approvals.map((decision) => `${statusLabel(decision.decision)} · ${decision.reviewer.displayName}${decision.note ? ` · ${decision.note}` : ""}`).join("；")}。这些决定不适用于当前版本。</p> : null}</div>)}</div>
        {comparison ? <div id="version-diff" className="content-version-diff"><h3>v{comparison.before.version} → 当前 v{comparison.after.version}</h3><p className="muted">变化：{comparison.changedFields.map((field) => ({ title: "标题", text: "正文", productDataVersion: "产品资料版本", promptVersionId: "生成指令版本" })[field]).join("、") || "可见字段无变化（恢复会生成新版本）"}</p><div className="content-diff-columns"><div><strong>先前版本 v{comparison.before.version}</strong><p>{comparison.before.title || "无标题"}</p><pre>{comparison.before.text}</pre></div><div><strong>当前版本 v{comparison.after.version}</strong><p>{comparison.after.title || "无标题"}</p><pre>{comparison.after.text}</pre></div></div></div> : <p className="muted">尚无可比较的历史版本。</p>}
      </section>
      {version ? <ContentActions key={version.id} contentId={id} versionId={version.id} title={version.title || ""} text={version.text} status={item.status} readOnly={context.role === "VIEWER"} mode={workspace.mode} timezone={workspace.timezone} approved={approved} blockingChecks={blockingChecks} hasConfirmedFacts={Boolean(item.plan.product?.fields.some((field) => field.status === "CONFIRMED" && field.value))} manualContent={sourceFacts.creationMethod === "MANUAL"} accountSelected={item.account.isSelected} publishingMode={publishingMode} versions={history.map((entry) => ({ id: entry.id, version: entry.version }))} /> : null}
    </div><aside className="content-detail-aside">
      <section className="panel content-detail-panel"><SectionHeader title="内容上下文" /><dl className="content-context-list"><div><dt>客户</dt><dd>{workspace.name}</dd></div><div><dt>产品</dt><dd>{item.plan.product?.name || "未关联产品"}</dd></div><div><dt>主题</dt><dd>{item.plan.theme}</dd></div><div><dt>业务目的</dt><dd>{item.plan.objective}</dd></div><div><dt>平台与账号</dt><dd>{platformLabel(item.platform)} · {item.account.displayName}</dd></div><div><dt>生成时产品资料</dt><dd>v{version?.productDataVersion ?? "—"}</dd></div></dl>
        <h3>同计划平台变体</h3><ul className="content-link-list">{item.plan.items.map((variant) => <li key={variant.id}><a className="text-link" href={`/content/${variant.id}`}>{platformLabel(variant.platform)} · {variant.account.displayName} · v{variant.currentVersion?.version ?? "—"}</a></li>)}</ul>
        <h3>已确认事实快照</h3>{factDetails.facts.length ? <dl className="content-context-list">{factDetails.facts.map((fact) => <div key={fact.key}><dt>{fact.key}</dt><dd>{fact.value}<small>来源：{fact.source}</small></dd></div>)}</dl> : <p className="muted">当前版本没有已确认事实快照。</p>}{factDetails.missing.length ? <p className="field-helper">生成时缺失或待确认：{factDetails.missing.join("、")}</p> : null}
      </section>
      <section className="panel content-detail-panel"><SectionHeader title="素材" description="使用当前版本已关联的素材。" />{version?.assetLinks.length ? <ul className="content-link-list">{version.assetLinks.map(({ asset }) => <li key={asset.id}><a className="text-link" href={`/api/assets/${asset.id}/file`} target="_blank" rel="noreferrer">{asset.originalName}</a><span>{statusLabel(asset.kind)}</span></li>)}</ul> : <p className="muted">当前版本未关联素材。</p>}</section>
      <section className="panel content-detail-panel"><SectionHeader title="AI 检查" description="模型输出声明及规则检查仅供人工参考，不代表正文事实已完整核验。" />{factDetails.reviews.length ? factDetails.reviews.map((review) => <div className="content-review-result" key={review.platform}><StatusIndicator value="AI_REVIEW" tone={review.passed ? "info" : "warning"} label={review.passed ? "AI 检查未报错" : "AI 检查发现问题"} compact />{review.findings.length ? <ul>{review.findings.map((finding, index) => <li key={index}>{finding.message}</li>)}</ul> : <p className="muted">没有模型规则告警，仍须人工核对事实和表达。</p>}</div>) : <p className="muted">此版本没有 AI 检查记录，不能据此视为已通过人工审核。</p>}{issues.length ? <ul className="content-check-list">{issues.map((issue) => <li key={issue.code}><StatusIndicator value={issue.level} label={issue.level === "ERROR" ? "阻断" : "提示"} compact />{issue.message}</li>)}</ul> : <p className="muted">规则检查未发现阻断；人工仍需复核。</p>}</section>
      <section className="panel content-detail-panel"><SectionHeader title="人工审核与修改意见" description="批准只对对应版本及账号有效。" />{version?.approvals.length ? version.approvals.map((entry) => <div className="content-history-entry" key={entry.id}><StatusIndicator value={entry.decision} compact /><span>{entry.reviewer.displayName} · v{version.version}</span><span>{formatDateTime(entry.createdAt, "—", workspace.timezone)}</span>{entry.note ? <p>{entry.note}</p> : null}</div>) : <p className="muted">当前版本尚无人工审核。</p>}{comments.length ? <div className="content-comment-list"><h3>修改意见历史</h3>{comments.map((entry) => <div className="content-history-entry" key={entry.id}><strong>v{entry.version} · {entry.reviewer.displayName}</strong><span>{formatDateTime(entry.createdAt, "—", workspace.timezone)}</span><p>{entry.comment}</p></div>)}</div> : null}</section>
      <section className="panel content-detail-panel"><SectionHeader title="排期与发布结果" action={<a className="text-link" href="/publishing">打开发布中心</a>} />{jobs.length ? jobs.map((job) => <div className="content-history-entry" key={job.id}><div className="row"><StatusIndicator value={job.status} compact /><StatusIndicator value={job.environment} compact /><span>v{job.version}</span></div><span>{formatDateTime(job.nextAttemptAt, "—", workspace.timezone)}</span>{job.status === "UNKNOWN" ? <p>结果待确认：平台可能已收到请求，不能盲目重试。请人工对账。</p> : null}{job.status === "FAILED" && job.lastErrorMessage ? <p>{job.lastErrorMessage}</p> : null}{job.status === "PUBLISHED" && safeRemotePostUrl(job.remotePostUrl) ? <a className="text-link" href={safeRemotePostUrl(job.remotePostUrl)!} target="_blank" rel="noreferrer">打开已发布内容</a> : null}</div>) : <EmptyState title="尚无发布任务" description="人工批准并排期后，这里会显示既有任务状态。" />}</section>
    </aside></div>
  </div></OperatorShell>;
}
