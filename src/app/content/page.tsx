import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function ContentPage() {
  const context = await requirePageContext();
  const [products, items, client] = await Promise.all([
    db.product.findMany({ where: { clientId: context.clientId }, include: { assetLinks: true }, orderBy: { updatedAt: "desc" } }),
    db.contentItem.findMany({
      where: { clientId: context.clientId },
      include: {
        plan: { include: { product: true } }, account: true,
        currentVersion: { include: { approvals: { orderBy: { createdAt: "desc" } }, assetLinks: true, publishJobs: { orderBy: { createdAt: "desc" }, include: { attempts: { orderBy: { number: "desc" } } } } } },
        versions: { select: { id: true, version: true, createdAt: true }, orderBy: { version: "desc" } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
  ]);
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>内容审核</h1><p className="muted">每个平台独立成品；批准绑定当前账号和不可变版本。</p></div></div>
      <section className="card" style={{ marginBottom: "1rem" }}><h2>生成四平台草稿</h2><form action="/api/content/generate" method="post" className="stack">
        <div className="row"><label>产品<select name="productId" required><option value="">请选择</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name}（素材 {product.assetLinks.length}）</option>)}</select></label><label>主题<input name="theme" placeholder="例如：经销商选品要点" required /></label><label>业务目的<input name="objective" defaultValue="获得经销商或批发商的有效询盘" required /></label></div>
        <input type="hidden" name="platforms" value="facebook,instagram,tiktok,linkedin" />
        <div className="warning">目标市场为空时只生成带标识的通用草稿，不自动批准市场方案。无模型凭据时输出会标为“模拟生成”。</div>
        <button disabled={products.length === 0}>生成草稿</button>
      </form></section>
      <div className="grid">
        {items.length === 0 && <section className="card span-12"><p className="muted">尚无内容。先录入产品，再生成草稿。</p></section>}
        {items.map((item) => {
          const version = item.currentVersion;
          const latestApproval = version?.approvals[0];
          const validApproval = latestApproval?.decision === "APPROVED" && latestApproval.accountId === item.accountId;
          return <article className="card span-6 stack" key={item.id}>
            <div className="row"><strong>{item.platform.toUpperCase()}</strong><span className="badge">{item.status}</span>{version?.simulated && <span className="badge mock">模拟生成</span>}<span className="badge">v{version?.version || "?"}</span></div>
            <small className="muted">{item.plan.product?.name || "无产品"} · 账号：{item.account.displayName} · 产品资料 v{version?.productDataVersion || "?"}</small>
            <form action={`/api/content/${item.id}/edit`} method="post" className="stack">
              <label>标题<input name="title" defaultValue={version?.title || ""} /></label>
              <label>平台文案<textarea name="text" defaultValue={version?.text || ""} required /></label>
              <button className="secondary">保存为新版本（旧审批失效）</button>
            </form>
            <div className="row">
              <form action={`/api/content/${item.id}/submit`} method="post"><button className="secondary">提交审核</button></form>
              <form action={`/api/content/${item.id}/review`} method="post"><input type="hidden" name="decision" value="APPROVED" /><button>批准当前版本</button></form>
              <form action={`/api/content/${item.id}/review`} method="post"><input type="hidden" name="decision" value="REJECTED" /><button className="danger">拒绝</button></form>
              <form action={`/api/content/${item.id}/schedule`} method="post"><button disabled={!validApproval}>排期{client.mode === "LIVE" ? "真实发布" : client.mode === "DEMO" ? "模拟发布" : "（草稿模式禁止发布）"}</button></form>
            </div>
            <div className={validApproval ? "warning" : "error"}>{validApproval ? `已批准 v${version?.version}，账号 ${item.account.displayName}` : "当前版本尚无有效批准，后端会阻止发布。"}</div>
            <small className="muted">历史版本：{item.versions.map((entry) => `v${entry.version}`).join("、")}</small>
            {version?.publishJobs.map((job) => <div className="list-item stack" key={job.id}><div className="row"><span className={`badge ${job.environment === "SIMULATED" ? "mock" : "ok"}`}>{job.environment}</span><strong>{job.status}</strong><small>尝试 {job.attemptCount}/{job.maxAttempts}</small></div>{job.remotePostId && <small>远端 ID：{job.remotePostId}</small>}{job.remotePostUrl && <a href={job.remotePostUrl} target="_blank" rel="noreferrer">打开远端帖子</a>}{job.lastErrorCode && <div className="error">{job.lastErrorCode}：{job.lastErrorMessage}</div>}{job.environment === "LIVE" && job.remotePostId && <form action={`/api/publish-jobs/${job.id}/query`} method="post"><button className="secondary">查询 Facebook 远端状态</button></form>}</div>)}
          </article>;
        })}
      </div>
    </OperatorShell>
  );
}
