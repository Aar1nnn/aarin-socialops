"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, FormField, Notice } from "@/components/ui";

type VersionOption = { id: string; version: number };
type ActionProps = {
  contentId: string;
  versionId: string;
  title: string;
  text: string;
  status: string;
  readOnly: boolean;
  mode: string;
  timezone: string;
  approved: boolean;
  blockingChecks: string[];
  hasConfirmedFacts: boolean;
  accountSelected: boolean;
  versions: VersionOption[];
};

export function ContentActions(props: ActionProps) {
  const router = useRouter();
  const [title, setTitle] = useState(props.title);
  const [text, setText] = useState(props.text);
  const [instruction, setInstruction] = useState("");
  const [rewriteAction, setRewriteAction] = useState("rewrite");
  const [comment, setComment] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [restoreId, setRestoreId] = useState("");
  const [publishMode, setPublishMode] = useState("SCHEDULED");
  const [localDateTime, setLocalDateTime] = useState("");
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; conflict: boolean } | null>(null);
  const [success, setSuccess] = useState("");
  const canEdit = !props.readOnly && ["DRAFT", "CHANGES_REQUESTED", "APPROVED", "FAILED"].includes(props.status);
  const canSubmit = !props.readOnly && ["DRAFT", "CHANGES_REQUESTED"].includes(props.status);
  const canReview = !props.readOnly && props.status === "REVIEW_PENDING";
  const canSchedule = !props.readOnly && props.status === "APPROVED" && props.approved && props.mode !== "DRAFT";

  async function act(path: string, body: Record<string, unknown>, successMessage: string) {
    setProblem(null);
    setSuccess("");
    setBusy(true);
    try {
      const response = await fetch(`/api/content/${props.contentId}/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...body, expectedVersionId: props.versionId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setProblem({ message: result.message || `操作失败（HTTP ${response.status}）`, conflict: response.status === 409 && ["VERSION_CONFLICT", "STALE_OPERATION"].includes(result.error) });
        return;
      }
      setSuccess(successMessage);
      router.refresh();
    } catch {
      setProblem({ message: "网络请求失败，请检查连接后重试；当前输入尚未丢失。", conflict: false });
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, path: string, body: Record<string, unknown>, message: string) {
    event.preventDefault();
    void act(path, body, message);
  }

  return <section className="content-action-stack" aria-label="内容操作">
    {problem ? <Notice title={problem.conflict ? "版本已被他人更新" : "操作未完成"} tone="danger">{problem.message}{problem.conflict ? <span> 当前输入仍保留在页面。请先复制未保存的文字，再<a className="text-link" href={`/content/${props.contentId}?compare=${props.versionId}`}>刷新并比较最新版本</a>后决定下一步。</span> : null}</Notice> : null}
    {success ? <Notice title="操作已提交" tone="success">{success}。页面会刷新显示服务端最新状态。</Notice> : null}
    {props.readOnly ? <Notice title="只读成员">当前角色不能保存、生成、审核或排期。</Notice> : null}
    {!props.hasConfirmedFacts ? <Notice title="没有已确认产品事实" tone="warning">先在产品页确认事实，再生成或审核内容。AI 不会把待确认事实作为可靠资料。</Notice> : null}
    {!props.accountSelected ? <Notice title="目标账号未选择" tone="warning">请先在<a className="text-link" href="/accounts">平台与账号</a>中选择该账号；正式发布还需完成账号验证。</Notice> : null}
    {props.blockingChecks.length ? <Notice title="内容检查阻断" tone="danger">{props.blockingChecks.join("；")}。修改并生成新版本后重新检查。</Notice> : null}
    {canEdit ? <section className="panel content-operation-panel"><h2>编辑当前版本</h2><p className="muted">保存会生成新 ContentVersion。旧版本及旧批准保留记录，但不能批准新版本。</p>
      <form className="form-stack" onSubmit={(event) => submit(event, "composition", { operation: "update_draft", title, text }, "已保存新草稿版本")}>
        <FormField label="标题" htmlFor="content-edit-title"><input id="content-edit-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></FormField>
        <FormField label="平台文案" htmlFor="content-edit-text"><textarea id="content-edit-text" value={text} required maxLength={100000} onChange={(event) => setText(event.target.value)} rows={8} /></FormField>
        <div><Button type="submit" variant="secondary" disabled={busy || !text.trim()}>保存为新版本</Button></div>
      </form>
      <div className="content-operation-divider" />
      <h3>AI 辅助改写</h3><p className="muted">模型仅接收已确认产品事实；结果是待人工检查的草稿，不会自动批准或创建发布任务。</p>
      <form className="form-stack" onSubmit={(event) => submit(event, "composition", { operation: "rewrite", action: rewriteAction, instruction }, "已生成待检查的新版本")}>
        <div className="form-grid"><FormField label="改写方式" htmlFor="content-rewrite-action"><select id="content-rewrite-action" value={rewriteAction} onChange={(event) => setRewriteAction(event.target.value)}><option value="rewrite">重新表达</option><option value="shorten">缩短</option><option value="expand">扩展</option><option value="professionalize">更专业</option><option value="humanize">更自然</option><option value="change_cta">调整行动号召</option><option value="change_hook">调整开头</option></select></FormField><FormField label="具体要求（可选）" htmlFor="content-rewrite-instruction"><input id="content-rewrite-instruction" value={instruction} maxLength={2000} onChange={(event) => setInstruction(event.target.value)} /></FormField></div>
        <div className="actions"><Button type="submit" variant="secondary" disabled={busy || !props.hasConfirmedFacts}>生成改写版本</Button><Button type="button" variant="secondary" disabled={busy || !props.hasConfirmedFacts} onClick={() => void act("composition", { operation: "regenerate_platform", instruction }, "已重生成当前平台版本")}>重生成本平台版本</Button></div>
      </form>
      {props.versions.length > 1 ? <form className="content-restore-form" onSubmit={(event) => submit(event, "versions", { versionId: restoreId }, "已从历史版本创建新版本")}><FormField label="从历史版本恢复" htmlFor="content-restore-version"><select id="content-restore-version" value={restoreId} onChange={(event) => setRestoreId(event.target.value)} required><option value="">选择版本</option>{props.versions.filter((entry) => entry.id !== props.versionId).map((entry) => <option key={entry.id} value={entry.id}>v{entry.version}</option>)}</select></FormField><Button type="submit" variant="secondary" disabled={busy || !restoreId}>恢复为新版本</Button></form> : null}
    </section> : null}
    <section className="panel content-operation-panel"><h2>人工审核</h2><p className="muted">AI 检查只提供风险提示。人工批准必须针对当前版本与目标账号。</p>
      {canSubmit ? <div className="actions"><Button type="button" variant="secondary" disabled={busy || props.blockingChecks.length > 0 || !props.hasConfirmedFacts} onClick={() => void act("submit", {}, "已提交人工审核")}>提交审核</Button></div> : null}
      {canReview ? <><form className="form-stack" onSubmit={(event) => submit(event, "review", { decision: "APPROVED", note: reviewNote }, "当前版本已获人工批准")}><FormField label="审核备注（可选）" htmlFor="content-review-note"><input id="content-review-note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></FormField><div><Button type="submit" disabled={busy || props.blockingChecks.length > 0 || !props.hasConfirmedFacts}>批准当前版本</Button></div></form><form className="form-stack" onSubmit={(event) => submit(event, "changes", { comment, requestedChanges: [{ instruction: comment }] }, "已请求修改并保留审核意见")}><FormField label="修改意见" htmlFor="content-change-comment"><textarea id="content-change-comment" value={comment} onChange={(event) => setComment(event.target.value)} required placeholder="明确指出需要修改的地方" /></FormField><div><Button type="submit" variant="danger" disabled={busy || !comment.trim()}>请求修改</Button></div></form></> : null}
      {!canSubmit && !canReview ? <p className="muted">{props.status === "APPROVED" ? "当前版本已批准；下一步是排期。" : props.readOnly ? "只读成员不能提交或批准。" : "当前状态不能提交或批准，请先检查版本与流程状态。"}</p> : null}
    </section>
    <section className="panel content-operation-panel"><h2>进入既有排期流程</h2><p className="muted">仅有效人工批准的当前版本可创建 PublishJob；此处不触发发布 Worker。</p>
      {canSchedule ? <form className="form-stack" onSubmit={(event) => submit(event, "schedule", { publishMode, localDateTime, timezone: props.timezone }, "已安排发布任务")}><div className="form-grid"><FormField label="排期方式" htmlFor="content-publish-mode"><select id="content-publish-mode" value={publishMode} onChange={(event) => setPublishMode(event.target.value)}><option value="SCHEDULED">按本地时间排期</option><option value="NOW">立即进入队列</option></select></FormField><FormField label="工作区本地时间" htmlFor="content-publish-time"><input id="content-publish-time" type="datetime-local" value={localDateTime} onChange={(event) => setLocalDateTime(event.target.value)} required={publishMode === "SCHEDULED"} disabled={publishMode !== "SCHEDULED"} /></FormField></div><p className="field-helper">时区：{props.timezone}。夏令时无效或重复时段由原排期服务拒绝。</p>{props.mode === "LIVE" ? <label className="content-live-confirm"><input type="checkbox" checked={liveConfirmed} onChange={(event) => setLiveConfirmed(event.target.checked)} />我已确认这是正式客户账号及内容</label> : null}<div><Button type="submit" disabled={busy || props.blockingChecks.length > 0 || (publishMode === "SCHEDULED" && !localDateTime) || (props.mode === "LIVE" && !liveConfirmed)}>{props.mode === "LIVE" ? "安排正式发布" : "安排模拟发布"}</Button></div></form> : <p className="muted">{props.mode === "DRAFT" ? "草稿模式不允许排期。" : !props.approved ? "等待当前版本与目标账号获得有效人工批准。" : props.readOnly ? "只读成员不能排期。" : "当前状态不能重新排期，请查看已有发布任务。"}</p>}
    </section>
  </section>;
}
