import { Fragment } from "react";

import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, platformLabel, statusLabel } from "@/lib/presentation/status";

type ContentFilter = {
  key: string;
  label: string;
  statuses: readonly string[] | null;
};

const CONTENT_FILTERS: readonly ContentFilter[] = [
  { key: "all", label: "全部", statuses: null },
  { key: "draft", label: "草稿", statuses: ["DRAFT"] },
  { key: "review", label: "待审核", statuses: ["REVIEW_PENDING"] },
  { key: "approved", label: "已批准", statuses: ["APPROVED"] },
  { key: "scheduled", label: "已排期", statuses: ["SCHEDULED", "RUNNING"] },
  { key: "published", label: "已发布", statuses: ["PUBLISHED"] },
  { key: "attention", label: "需处理", statuses: ["CHANGES_REQUESTED", "WAITING_CONFIGURATION", "FAILED", "UNKNOWN"] },
];

const PRODUCT_FACT_LABELS: Record<string, string> = {
  material: "材质",
  dimensions: "尺寸",
  supply_scope: "供货范围",
};

function productFactLabel(key: string) {
  return PRODUCT_FACT_LABELS[key] ?? key.replaceAll("_", " ");
}

type SourceFact = { key: string; value: string; source: string };

function parseSourceFacts(value: unknown): { confirmedFacts: SourceFact[]; missingFields: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { confirmedFacts: [], missingFields: [] };
  }
  const record = value as Record<string, unknown>;
  const confirmedFacts = Array.isArray(record.confirmedFacts)
    ? record.confirmedFacts.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const fact = candidate as Record<string, unknown>;
        if (typeof fact.key !== "string" || typeof fact.value !== "string") return [];
        return [{
          key: fact.key,
          value: fact.value,
          source: typeof fact.source === "string" ? fact.source : "未记录来源",
        }];
      })
    : [];
  const missingFields = Array.isArray(record.missingFields)
    ? record.missingFields.filter((field): field is string => typeof field === "string")
    : [];
  return { confirmedFacts, missingFields };
}

function preview(value: string, maxLength = 110) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function matchesFilter(status: string, filter: ContentFilter) {
  return filter.statuses === null || filter.statuses.includes(status);
}

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; create?: string | string[] }>;
}) {
  const context = await requirePageContext();
  const params = await searchParams;
  const requestedStatus = params.status;
  const requestedFilter = Array.isArray(requestedStatus) ? requestedStatus[0] : requestedStatus;
  const requestedCreate = Array.isArray(params.create) ? params.create[0] : params.create;
  const createRequested = requestedCreate === "1";
  const activeFilter = CONTENT_FILTERS.find((filter) => filter.key === requestedFilter) ?? CONTENT_FILTERS[0];
  const readOnly = context.role === "VIEWER";
  const [products, items, client, accounts] = await Promise.all([
    db.product.findMany({
      where: { clientId: context.clientId },
      include: { assetLinks: true },
      orderBy: { updatedAt: "desc" },
    }),
    db.contentItem.findMany({
      where: { clientId: context.clientId },
      include: {
        plan: { include: { product: true } },
        account: { select: { id: true, displayName: true, platform: true } },
        currentVersion: {
          include: {
            approvals: {
              orderBy: { createdAt: "desc" },
              include: { reviewer: { select: { displayName: true } } },
            },
            assetLinks: {
              include: { asset: { select: { id: true, originalName: true, kind: true } } },
            },
          },
        },
        versions: {
          orderBy: { version: "desc" },
          include: {
            publishJobs: {
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    db.client.findUniqueOrThrow({
      where: { id: context.clientId },
      select: { mode: true, timezone: true, targetMarkets: true },
    }),
    db.socialAccount.findMany({
      where: { clientId: context.clientId, isSelected: true },
      orderBy: [{ platform: "asc" }, { displayName: "asc" }],
      select: { id: true, platform: true, displayName: true, publishCapability: true },
    }),
  ]);

  const filteredItems = items.filter((item) => matchesFilter(item.status, activeFilter));
  const filterCounts = new Map(CONTENT_FILTERS.map((filter) => [
    filter.key,
    items.filter((item) => matchesFilter(item.status, filter)).length,
  ]));

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader
          title="内容"
          description="创建、审核并安排各平台内容。"
          action={readOnly ? null : (
            <a
              className="button button-primary button-md"
              href="/content?create=1#new-content"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              创建内容
            </a>
          )}
        />

        {readOnly ? (
          <Notice title="只读访问">
            当前角色可查看内容、审核记录和发布结果。创建、编辑、审核与排期需要编辑权限。
          </Notice>
        ) : (
          <details className="disclosure" id="new-content" open={items.length === 0 || createRequested}>
            <summary>创建内容</summary>
            <form action="/api/content/generate" method="post" className="disclosure-body form-stack form-width">
            <div className="form-grid">
              <FormField label="产品" htmlFor="content-product">
                <select id="content-product" name="productId" required disabled={readOnly}>
                  <option value="">请选择产品</option>
                  {products.map((product) => (
                    <option value={product.id} key={product.id}>{product.name}（素材 {product.assetLinks.length}）</option>
                  ))}
                </select>
              </FormField>
              <FormField label="主题" htmlFor="content-theme">
                <input id="content-theme" name="theme" placeholder="例如：经销商选品要点" required disabled={readOnly} />
              </FormField>
              <FormField label="业务目的" htmlFor="content-objective" className="span-full">
                <input id="content-objective" name="objective" defaultValue="获得经销商或批发商的有效询盘" required disabled={readOnly} />
              </FormField>
            </div>

            <fieldset className="stack-tight" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend style={{ marginBottom: "8px", fontSize: "13px", fontWeight: 600 }}>目标账号</legend>
              {accounts.length === 0 ? (
                <Notice title="尚无可选账号" tone="warning">请先在平台连接中选择用于内容发布的账号。</Notice>
              ) : accounts.map((account) => (
                <label className="account-option" htmlFor={`target-account-${account.id}`} key={account.id}>
                  <input
                    id={`target-account-${account.id}`}
                    type="checkbox"
                    name="accountIds"
                    value={account.id}
                    defaultChecked
                    disabled={readOnly}
                  />
                  <span>
                    <strong>{platformLabel(account.platform)}</strong>
                    <span className="cell-meta">{account.displayName}</span>
                  </span>
                  <StatusIndicator
                    value={account.publishCapability}
                    label={account.publishCapability === "VERIFIED" ? "发布可用" : undefined}
                    compact
                  />
                </label>
              ))}
            </fieldset>

            {client.targetMarkets.length === 0 ? (
              <Notice title="目标市场尚未设置" tone="warning">生成结果会标记为通用草稿，仍需按现有流程审核后才能排期。</Notice>
            ) : null}

            <div>
              <Button type="submit" disabled={readOnly || products.length === 0 || accounts.length === 0}>生成草稿</Button>
            </div>
            </form>
          </details>
        )}

        <nav className="subnav" aria-label="内容状态">
          {CONTENT_FILTERS.map((filter) => {
            const href = filter.key === "all" ? "/content#content-list" : `/content?status=${filter.key}#content-list`;
            return (
              <a
                className={filter.key === activeFilter.key ? "active" : undefined}
                href={href}
                key={filter.key}
                aria-current={filter.key === activeFilter.key ? "page" : undefined}
              >
                {filter.label} <span className="number">{filterCounts.get(filter.key) ?? 0}</span>
              </a>
            );
          })}
        </nav>

        <section className="panel" id="content-list" aria-label="内容列表">
          <SectionHeader title="内容列表" description={`${activeFilter.label} · ${filteredItems.length} 条`} />
          {items.length === 0 ? (
            <EmptyState
              title="还没有内容"
              description="创建第一条内容后，即可进入审核和发布流程。"
              action={readOnly ? null : <a className="text-link" href="/content?create=1#new-content">创建内容</a>}
            />
          ) : filteredItems.length === 0 ? (
            <EmptyState title={`没有${activeFilter.label}内容`} description="切换状态查看其他内容。" />
          ) : (
            <div className="table-scroll" role="region" aria-label="内容运营列表" tabIndex={0}>
              <table className="content-operations-table">
                <thead>
                  <tr>
                    <th>内容</th>
                    <th>状态</th>
                    <th>渠道</th>
                    <th>账号</th>
                    <th>产品</th>
                    <th>排期</th>
                    <th>更新</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const version = item.currentVersion;
                    const latestApproval = version?.approvals[0];
                    const validApproval = latestApproval?.decision === "APPROVED" && latestApproval.accountId === item.accountId;
                    const canEdit = Boolean(version) && ["DRAFT", "CHANGES_REQUESTED", "APPROVED", "FAILED"].includes(item.status);
                    const canSubmit = Boolean(version) && ["DRAFT", "CHANGES_REQUESTED"].includes(item.status);
                    const canReview = Boolean(version) && item.status === "REVIEW_PENDING";
                    const canSchedule = Boolean(version) && item.status === "APPROVED" && validApproval;
                    const contentTitle = version?.title?.trim() || item.plan.theme;
                    const sourceFacts = parseSourceFacts(version?.sourceFacts);
                    const versionJobs = item.versions
                      .flatMap((entry) => entry.publishJobs.map((job) => ({ ...job, contentVersionNumber: entry.version })))
                      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
                    return (
                      <Fragment key={item.id}>
                        <tr>
                          <td>
                            <span className="cell-title">{contentTitle}</span>
                            <span className="cell-meta">{version ? preview(version.text) : "当前内容版本缺失"}</span>
                          </td>
                          <td><StatusIndicator value={item.status} compact /></td>
                          <td>{platformLabel(item.platform)}</td>
                          <td>{item.account.displayName}</td>
                          <td>{item.plan.product?.name || "未关联产品"}</td>
                          <td className="number">{formatDateTime(item.scheduledAt, "未排期", client.timezone)}</td>
                          <td className="number">{formatDateTime(item.updatedAt, "—", client.timezone)}</td>
                        </tr>
                        <tr className="content-detail-row">
                          <td colSpan={7}>
                            <details className="disclosure" id={`content-${item.id}`}>
                              <summary>查看内容详情与操作</summary>
                              <div className="disclosure-body detail-sections">
                          <section className="detail-section">
                            <SectionHeader
                              title="内容版本"
                              description={`v${version?.version ?? "—"} · 产品资料 v${version?.productDataVersion ?? "—"}`}
                              action={version?.simulated ? <StatusIndicator value="SIMULATED" label="模拟生成" compact /> : null}
                            />
                            {version ? <div className="preview">{version.text}</div> : <Notice title="内容版本缺失" tone="danger">当前记录无法编辑或进入审核，请联系管理员检查数据。</Notice>}
                            <div className="row">
                              <span className="muted">关联素材 {version?.assetLinks.length ?? 0}</span>
                              <span className="muted">历史版本 {item.versions.map((entry) => `v${entry.version}`).join("、") || "—"}</span>
                            </div>

                            <div className="split-layout content-context">
                              <div className="stack-tight">
                                <h3>产品事实快照</h3>
                                <p className="cell-meta">
                                  {item.plan.product?.name || "未关联产品"} · 生成时产品资料 v{version?.productDataVersion ?? "—"}
                                </p>
                                {sourceFacts.confirmedFacts.length === 0 ? (
                                  <p className="muted">当前版本没有已确认的产品事实。</p>
                                ) : (
                                  <div className="table-scroll" role="region" aria-label={`${contentTitle} 产品事实快照`} tabIndex={0}>
                                    <table>
                                      <thead><tr><th>字段</th><th>值</th><th>来源</th></tr></thead>
                                      <tbody>
                                        {sourceFacts.confirmedFacts.map((field) => (
                                          <tr key={`${field.key}-${field.source}`}>
                                            <td>{productFactLabel(field.key)}</td>
                                            <td>{field.value}</td>
                                            <td>{field.source}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                                {sourceFacts.missingFields.length > 0 ? (
                                  <p className="field-helper">
                                    生成时未确认：{sourceFacts.missingFields.map(productFactLabel).join("、")}
                                  </p>
                                ) : null}
                              </div>

                              <div className="stack-tight">
                                <h3>关联素材</h3>
                                {!version || version.assetLinks.length === 0 ? (
                                  <p className="muted">当前版本未关联素材。</p>
                                ) : (
                                  <ul className="asset-list">
                                    {version.assetLinks.map(({ asset }) => (
                                      <li key={asset.id}>
                                        <a className="text-link" href={`/api/assets/${asset.id}/file`} target="_blank" rel="noreferrer">
                                          {asset.originalName}
                                        </a>
                                        <span className="cell-meta">{statusLabel(asset.kind)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>

                            {canEdit ? (
                              <details className="disclosure">
                                <summary>编辑并保存为新版本</summary>
                                <form action={`/api/content/${item.id}/edit`} method="post" className="disclosure-body form-stack form-width">
                                  <FormField label="标题" htmlFor={`content-title-${item.id}`}>
                                    <input id={`content-title-${item.id}`} name="title" defaultValue={version?.title || ""} disabled={readOnly} />
                                  </FormField>
                                  <FormField label="平台文案" htmlFor={`content-text-${item.id}`} helper="保存后会创建新版本，旧版本的批准不再适用。">
                                    <textarea id={`content-text-${item.id}`} name="text" defaultValue={version?.text || ""} required disabled={readOnly} />
                                  </FormField>
                                  <div><Button type="submit" variant="secondary" disabled={readOnly}>保存为新版本</Button></div>
                                </form>
                              </details>
                            ) : null}
                          </section>

                          <section className="detail-section">
                            <SectionHeader title="审核流程" description="批准只绑定当前版本和目标账号。" />
                            <div className="row">
                              <StatusIndicator value={item.status} />
                              <span className="muted">当前账号：{item.account.displayName}</span>
                            </div>

                            {latestApproval ? (
                              <div className="structured-row stack-tight">
                                <div className="row">
                                  <StatusIndicator value={latestApproval.decision} />
                                  <strong>v{version?.version ?? "—"}</strong>
                                  <span className="muted">审核人：{latestApproval.reviewer.displayName}</span>
                                  <span className="muted">{formatDateTime(latestApproval.createdAt, "—", client.timezone)}</span>
                                </div>
                                {latestApproval.note ? <p className="muted">{latestApproval.note}</p> : null}
                              </div>
                            ) : (
                              <p className="muted">当前版本尚无审核记录。</p>
                            )}

                            <div className="actions">
                              {canSubmit ? (
                                <form action={`/api/content/${item.id}/submit`} method="post">
                                  <Button type="submit" variant="secondary" disabled={readOnly}>
                                    提交审核
                                  </Button>
                                </form>
                              ) : null}
                              {canReview ? (
                                <>
                                  <form action={`/api/content/${item.id}/review`} method="post">
                                    <input type="hidden" name="decision" value="APPROVED" />
                                    <Button type="submit" disabled={readOnly}>批准当前版本</Button>
                                  </form>
                                  <form action={`/api/content/${item.id}/review`} method="post">
                                    <input type="hidden" name="decision" value="REJECTED" />
                                    <Button type="submit" variant="danger" disabled={readOnly}>拒绝并退回</Button>
                                  </form>
                                </>
                              ) : null}
                            </div>
                          </section>

                          <section className="detail-section">
                              <SectionHeader title="发布安排" description={`当前工作区时区：${client.timezone}`} />
                            {canSchedule ? (
                              <form action={`/api/content/${item.id}/schedule`} method="post" className="form-stack form-width">
                                <div className="form-grid">
                                  <FormField label="发布方式" htmlFor={`publish-mode-${item.id}`}>
                                    <select id={`publish-mode-${item.id}`} name="publishMode" defaultValue="NOW" disabled={readOnly || client.mode === "DRAFT"}>
                                      <option value="NOW">立即进入队列</option>
                                      <option value="SCHEDULED">按本地时间排期</option>
                                    </select>
                                  </FormField>
                                  <FormField label="计划发布时间" htmlFor={`publish-time-${item.id}`} helper="选择按本地时间排期时填写。">
                                    <input id={`publish-time-${item.id}`} name="localDateTime" type="datetime-local" disabled={readOnly || client.mode === "DRAFT"} />
                                  </FormField>
                                </div>
                                <input type="hidden" name="timezone" value={client.timezone} />
                                {client.mode === "DRAFT" ? (
                                  <Notice title="草稿模式不执行发布" tone="warning">切换运行模式并完成账号验证后，才能创建发布任务。</Notice>
                                ) : null}
                                <div>
                                  <Button type="submit" disabled={readOnly || client.mode === "DRAFT"}>
                                    {client.mode === "LIVE" ? "安排正式发布" : "安排模拟发布"}
                                  </Button>
                                </div>
                              </form>
                            ) : item.status === "APPROVED" ? (
                              <Notice title="当前批准不可用于排期" tone="warning">请确认批准记录仍绑定当前版本和目标账号。</Notice>
                            ) : (
                              <p className="muted">内容批准后可立即进入队列，或按工作区本地时间排期。</p>
                            )}

                            {versionJobs.length === 0 ? (
                              <EmptyState title="还没有发布记录" description="完成批准并排期后，任务状态会显示在这里。" />
                            ) : (
                              <div className="list">
                                {versionJobs.map((job) => (
                                  <article className="list-item stack-tight" key={job.id}>
                                    <div className="toolbar">
                                        <div className="row">
                                          <StatusIndicator value={job.status} />
                                          <StatusIndicator value={job.environment} compact />
                                          <span className="cell-meta">内容 v{job.contentVersionNumber}</span>
                                        </div>
                                      <span className="cell-meta">尝试 {job.attemptCount}/{job.maxAttempts}</span>
                                    </div>
                                    {job.status === "UNKNOWN" ? (
                                      <Notice title="发布结果待确认" tone="warning">
                                        平台可能已经收到请求。系统不会自动重试，请先查询平台状态或前往总览完成人工对账。
                                      </Notice>
                                    ) : null}
                                    <div className="actions">
                                      {job.remotePostUrl ? <a className="text-link" href={job.remotePostUrl} target="_blank" rel="noreferrer">打开远端帖子</a> : null}
                                      {job.environment === "LIVE" && job.remotePostId ? (
                                        <form action={`/api/publish-jobs/${job.id}/query`} method="post">
                                          <Button type="submit" variant="secondary" size="sm" disabled={readOnly}>查询平台状态</Button>
                                        </form>
                                      ) : null}
                                      {job.status === "UNKNOWN" ? <a className="text-link" href="/#attention">前往人工对账</a> : null}
                                    </div>
                                    {job.remotePostId || job.lastErrorCode ? (
                                      <details className="technical-details">
                                        <summary>技术详情</summary>
                                        {job.remotePostId ? <p>远端帖子 ID：<code>{job.remotePostId}</code></p> : null}
                                        {job.lastErrorCode ? <p><code>{job.lastErrorCode}</code>{job.lastErrorMessage ? ` · ${job.lastErrorMessage}` : ""}</p> : null}
                                      </details>
                                    ) : null}
                                  </article>
                                ))}
                              </div>
                            )}
                          </section>
                              </div>
                            </details>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </OperatorShell>
  );
}
