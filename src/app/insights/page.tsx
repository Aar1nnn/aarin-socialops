import { Fragment } from "react";

import { OperatorShell } from "@/components/operator-shell";
import {
  Button,
  EmptyState,
  FormField,
  Notice,
  PageHeader,
  SectionHeader,
  StatusIndicator,
} from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { canWrite } from "@/lib/context";
import { db } from "@/lib/db";
import { formatDateTime, platformLabel } from "@/lib/presentation/status";

function jsonList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function excerpt(value: string, length = 110) {
  return value.length > length ? `${value.slice(0, length).trimEnd()}…` : value;
}

function interactionTypeLabel(value: string) {
  const labels: Record<string, string> = {
    COMMENT: "评论",
    MESSAGE: "私信",
    MANUAL_NOTE: "人工记录",
  };
  return labels[value] ?? value;
}

function metricSourceLabel(value: string) {
  if (value.startsWith("meta-oauth:") || value.startsWith("facebook-graph:")) return "Facebook";
  if (value.toLowerCase().includes("mock")) return "模拟数据源";
  return "外部平台";
}

const metricLabels: Record<string, string> = {
  comments: "评论数",
  engagement: "互动数",
  engaged_users: "互动用户数",
  impressions: "展示次数",
  page_engaged_users: "Page 互动用户数",
  page_fans: "Page 关注者数",
  page_impressions: "Page 展示次数",
  page_post_engagements: "Page 帖子互动数",
  page_video_views: "Page 视频播放次数",
  page_views_total: "Page 访问次数",
  post_comments_total: "帖子评论数",
  post_engagement: "帖子互动",
  post_impressions: "帖子展示次数",
  post_reactions_total: "帖子回应数",
  qualified_leads: "合格线索数",
  reach: "覆盖人数",
};

function metricLabel(value: string) {
  const baseKey = value.split(":", 1)[0]?.trim() || value.trim();
  const knownLabel = metricLabels[baseKey.toLowerCase()];
  if (knownLabel) return knownLabel;
  const readableKey = baseKey.replace(/[_-]+/g, " ").trim();
  return readableKey ? `自定义指标：${readableKey}` : "未命名指标";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reportSummary(value: unknown) {
  const facts = asRecord(value);
  if (!facts) return "暂无可展示的业务摘要。";

  const parts: string[] = [];
  const publishedPosts = asRecord(facts.publishedPosts);
  const publishedTotal = asFiniteNumber(publishedPosts?.total);
  const importedInteractions = asFiniteNumber(facts.importedInteractions);
  const qualifiedLeadRecords = asFiniteNumber(facts.qualifiedLeadRecords);
  const metricSnapshots = asFiniteNumber(facts.metricSnapshots);

  if (publishedTotal !== null) parts.push(`发布 ${publishedTotal} 条`);
  if (importedInteractions !== null) parts.push(`导入互动 ${importedInteractions} 条`);
  if (qualifiedLeadRecords !== null) parts.push(`识别线索 ${qualifiedLeadRecords} 条`);
  if (metricSnapshots !== null) parts.push(`指标快照 ${metricSnapshots} 份`);

  const availableMetrics = Array.isArray(facts.availableMetrics)
    ? facts.availableMetrics
        .map(asRecord)
        .filter((metric): metric is Record<string, unknown> => metric !== null)
        .flatMap((metric) => {
          if (typeof metric.key !== "string") return [];
          const metricValue = typeof metric.value === "string" || typeof metric.value === "number"
            ? String(metric.value)
            : null;
          return metricValue === null ? [] : [`${metricLabel(metric.key)} ${metricValue}`];
        })
        .slice(0, 3)
    : [];

  if (availableMetrics.length) parts.push(`可用指标：${availableMetrics.join("、")}`);
  return parts.length ? `${parts.join("；")}。` : "暂无可展示的业务摘要。";
}

export default async function InsightsPage() {
  const context = await requirePageContext();
  const hasWriteAccess = canWrite(context.role);
  const [accounts, interactions, leads, metrics, reports, client, livePosts] = await Promise.all([
    db.socialAccount.findMany({
      where: { clientId: context.clientId },
      include: { facebookConnection: true, platformConnection: true },
      orderBy: [{ platform: "asc" }, { displayName: "asc" }],
    }),
    db.interaction.findMany({
      where: { clientId: context.clientId },
      include: { account: true, lead: true },
      orderBy: { importedAt: "desc" },
      take: 20,
    }),
    db.lead.findMany({
      where: { clientId: context.clientId },
      include: { interaction: { include: { account: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.metricSnapshot.findMany({
      where: { clientId: context.clientId },
      include: { account: true },
      orderBy: { fetchedAt: "desc" },
      take: 30,
    }),
    db.operationReport.findMany({
      where: { clientId: context.clientId },
      orderBy: { generatedAt: "desc" },
      take: 5,
    }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.publishJob.findMany({
      where: {
        clientId: context.clientId,
        environment: "LIVE",
        adapter: { in: ["facebook-graph", "meta-facebook"] },
        remotePostId: { not: null },
      },
      include: { account: true },
      orderBy: { publishedAt: "desc" },
      take: 20,
    }),
  ]);

  const importPlatforms = Array.from(new Set(accounts.map((account) => account.platform)));
  const metricSyncAccounts = accounts.filter(
    (account) => account.platform === "facebook" && account.metricsCapability === "VERIFIED",
  );

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader
          title="互动与线索"
          description="跟进采购线索，查看互动、指标和运营复盘。"
        />

        {!hasWriteAccess ? (
          <Notice title="只读访问">
            当前角色可查看线索、互动、指标和复盘，不能更新线索、导入数据或触发同步。
          </Notice>
        ) : null}

        <nav className="subnav" aria-label="线索与数据分区">
          <a href="#leads">线索</a>
          <a href="#interactions">互动</a>
          <a href="#metrics">指标</a>
          <a href="#reports">复盘</a>
        </nav>

        <section className="section" id="leads">
          <SectionHeader
            title="线索"
            description="最近识别的采购意向与人工交接状态。"
          />
          {leads.length === 0 ? (
            <EmptyState
              title="还没有线索"
              description="符合采购意向的互动会在完成分类后出现在这里。"
            />
          ) : (
            <div className="table-scroll" role="region" aria-label="线索列表" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>优先级</th>
                    <th>线索</th>
                    <th>意向</th>
                    <th>来源</th>
                    <th>状态</th>
                    <th>收到时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <Fragment key={lead.id}>
                      <tr>
                        <td><StatusIndicator value={lead.priority} compact /></td>
                        <td>
                          <span className="cell-title">
                            {lead.interaction.authorDisplay || lead.interaction.authorHandle || "未记录姓名"}
                          </span>
                          <span className="cell-meta">{excerpt(lead.interaction.body)}</span>
                        </td>
                        <td><StatusIndicator value={lead.category} compact /></td>
                        <td>
                          <span className="cell-title">{platformLabel(lead.interaction.platform)}</span>
                          <span className="cell-meta">
                            {lead.interaction.account?.displayName || "未关联账号"}
                          </span>
                        </td>
                        <td><StatusIndicator value={lead.handoffStatus} compact /></td>
                        <td className="number">{formatDateTime(lead.createdAt, "—", client.timezone)}</td>
                        <td><span className="cell-meta">下方可展开</span></td>
                      </tr>
                      <tr className="lead-detail-row">
                        <td colSpan={7}>
                        <details className="disclosure" id={`lead-details-${lead.id}`}>
                          <summary>查看与处理</summary>
                          <div className="disclosure-body stack">
                            <div className="preview">{lead.interaction.body}</div>
                            <p className="muted">判断依据：{lead.rationale}</p>
                            {lead.interaction.sourceUrl ? (
                              <a className="text-link" href={lead.interaction.sourceUrl} target="_blank" rel="noreferrer">
                                查看原始互动
                              </a>
                            ) : null}
                            {lead.verificationNeeded ? (
                              <Notice title="需要核实" tone="warning">
                                {lead.verificationNeeded}
                              </Notice>
                            ) : null}
                            <form action={`/api/leads/${lead.id}`} method="post" className="form-stack">
                              <FormField label="交接状态" htmlFor={`lead-status-${lead.id}`}>
                                <select
                                  id={`lead-status-${lead.id}`}
                                  name="status"
                                  defaultValue={lead.handoffStatus}
                                  disabled={!hasWriteAccess}
                                >
                                  <option value="NEW">新线索</option>
                                  <option value="REPLIED">已人工回复</option>
                                  <option value="HANDED_OFF">已转交客户负责人</option>
                                  <option value="WAITING_FEEDBACK">等待反馈</option>
                                  <option value="CLOSED">已关闭</option>
                                  <option value="DISMISSED">排除</option>
                                </select>
                              </FormField>
                              <FormField label="销售反馈" htmlFor={`lead-feedback-${lead.id}`}>
                                <input
                                  id={`lead-feedback-${lead.id}`}
                                  name="feedback"
                                  defaultValue={lead.salesFeedback || ""}
                                  placeholder="记录跟进结果（可选）"
                                  disabled={!hasWriteAccess}
                                />
                              </FormField>
                              <Button type="submit" size="sm" disabled={!hasWriteAccess}>保存交接</Button>
                            </form>
                          </div>
                        </details>
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" id="interactions">
          <SectionHeader title="互动" description="来自平台的公开互动和人工补录记录。" />
          <div className="stack">
            <details className="disclosure">
              <summary>人工导入互动</summary>
              <div className="disclosure-body stack">
                <form action="/api/interactions" method="post" className="form-stack form-width">
                  <div className="form-grid">
                    <FormField label="平台" htmlFor="interaction-platform">
                      <select id="interaction-platform" name="platform" disabled={!hasWriteAccess}>
                        {importPlatforms.map((platform) => (
                          <option key={platform} value={platform}>{platformLabel(platform)}</option>
                        ))}
                      </select>
                    </FormField>
                    <FormField
                      label="平台记录 ID"
                      htmlFor="interaction-record-id"
                      helper="使用平台返回的稳定 ID，避免重复导入。"
                    >
                      <input
                        id="interaction-record-id"
                        name="platformRecordId"
                        aria-describedby="interaction-record-id-helper"
                        required
                        disabled={!hasWriteAccess}
                      />
                    </FormField>
                    <FormField label="互动类型" htmlFor="interaction-type">
                      <select id="interaction-type" name="interactionType" disabled={!hasWriteAccess}>
                        <option value="COMMENT">评论</option>
                        <option value="MESSAGE">私信（人工导入）</option>
                        <option value="MANUAL_NOTE">人工记录</option>
                      </select>
                    </FormField>
                    <FormField label="作者用户名" htmlFor="interaction-author">
                      <input id="interaction-author" name="authorHandle" disabled={!hasWriteAccess} />
                    </FormField>
                    <FormField label="来源链接" htmlFor="interaction-source-url" className="span-full">
                      <input id="interaction-source-url" name="sourceUrl" type="url" disabled={!hasWriteAccess} />
                    </FormField>
                    <FormField label="原文" htmlFor="interaction-body" className="span-full">
                      <textarea
                        id="interaction-body"
                        name="body"
                        placeholder="粘贴客户的原始评论或询盘内容"
                        required
                        disabled={!hasWriteAccess}
                      />
                    </FormField>
                  </div>
                  <div className="actions">
                    <Button type="submit" disabled={!hasWriteAccess || importPlatforms.length === 0}>导入并分类</Button>
                  </div>
                </form>
                <Notice title="自动化边界">
                  导入后会进行线索分类；回复、报价和交接仍由运营人员确认。
                </Notice>
              </div>
            </details>

            {interactions.length === 0 ? (
              <EmptyState
                title="还没有互动"
                description="同步平台评论或人工导入后，互动记录会显示在这里。"
              />
            ) : (
              <div className="list">
                {interactions.map((interaction) => (
                  <article key={interaction.id} className="structured-row stack-tight">
                    <div className="toolbar">
                      <div>
                        <strong>{interaction.authorDisplay || interaction.authorHandle || "未记录姓名"}</strong>
                        <div className="cell-meta">
                          {platformLabel(interaction.platform)} · {interaction.account?.displayName || "未关联账号"}
                          {" · "}{interactionTypeLabel(interaction.interactionType)}
                          {" · "}{formatDateTime(interaction.occurredAt, "—", client.timezone)}
                        </div>
                      </div>
                      {interaction.lead ? (
                        <StatusIndicator value={interaction.lead.category} label="已生成线索" compact />
                      ) : (
                        <StatusIndicator label="普通互动" tone="neutral" compact />
                      )}
                    </div>
                    <p>{interaction.body}</p>
                    <div className="actions">
                      {interaction.sourceUrl ? (
                        <a className="text-link" href={interaction.sourceUrl} target="_blank" rel="noreferrer">
                          查看来源
                        </a>
                      ) : null}
                      <details className="technical-details">
                        <summary>技术详情</summary>
                        <p>平台记录 ID：<code>{interaction.platformRecordId}</code></p>
                      </details>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="section" id="metrics">
          <SectionHeader
            title="指标"
            description="查看账号和帖子指标的可用性、来源与最近同步时间。"
            action={(
              <div className="actions">
                {client.isDemo ? (
                  <form action="/api/metrics/mock" method="post">
                    <Button type="submit" variant="secondary" size="sm" disabled={!hasWriteAccess}>生成模拟指标</Button>
                  </form>
                ) : null}
                {metricSyncAccounts.map((account) => (
                  <form action="/api/facebook/metrics/sync" method="post" key={account.id}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <Button type="submit" variant="secondary" size="sm" disabled={!hasWriteAccess}>同步 {account.displayName}</Button>
                  </form>
                ))}
              </div>
            )}
          />

          <div className="stack">
            {metricSyncAccounts.length === 0 ? (
              <Notice title="暂无可同步账号">
                在平台连接中完成指标权限验证后，这里会显示真实指标同步入口。
              </Notice>
            ) : null}

            <div>
              <h3>Facebook 帖子数据</h3>
              <p className="muted">同步已发布帖子的互动汇总，或读取公开评论并进入线索流程。</p>
              {livePosts.length === 0 ? (
                <EmptyState
                  title="还没有可同步的 Facebook 帖子"
                  description="带远端帖子 ID 的正式发布记录会出现在这里。"
                />
              ) : (
                <div className="list">
                  {livePosts.map((job) => (
                    <article className="structured-row toolbar" key={job.id}>
                      <div>
                        <strong>{job.account.displayName}</strong>
                        <div className="cell-meta">
                          {platformLabel(job.account.platform)} · {formatDateTime(job.publishedAt, "发布时间未返回", client.timezone)}
                        </div>
                      </div>
                      <div className="actions">
                        <form action="/api/facebook/post-metrics/sync" method="post">
                          <input type="hidden" name="publishJobId" value={job.id} />
                          <Button
                            type="submit"
                            variant="secondary"
                            size="sm"
                            disabled={!hasWriteAccess || job.account.metricsCapability !== "VERIFIED"}
                            aria-describedby={job.account.metricsCapability === "VERIFIED" ? undefined : `metrics-sync-help-${job.id}`}
                          >
                            同步互动指标
                          </Button>
                        </form>
                        <form action="/api/facebook/comments/sync" method="post">
                          <input type="hidden" name="publishJobId" value={job.id} />
                          <Button
                            type="submit"
                            variant="secondary"
                            size="sm"
                            disabled={!hasWriteAccess || job.account.commentsCapability !== "VERIFIED"}
                            aria-describedby={job.account.commentsCapability === "VERIFIED" ? undefined : `comments-sync-help-${job.id}`}
                          >
                            读取公开评论
                          </Button>
                        </form>
                      </div>
                      {job.account.metricsCapability !== "VERIFIED" ? (
                        <p className="cell-meta" id={`metrics-sync-help-${job.id}`}>
                          互动指标同步不可用：该账号尚未通过指标权限验证。
                        </p>
                      ) : null}
                      {job.account.commentsCapability !== "VERIFIED" ? (
                        <p className="cell-meta" id={`comments-sync-help-${job.id}`}>
                          公开评论读取不可用：该账号尚未通过评论权限验证。
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <Notice title="数据口径">
              真实的数值 0 会正常保存；未同步、不支持、权限不足和同步失败会分别标记。模拟数据不会计入真实表现。
            </Notice>

            {metrics.length === 0 ? (
              <EmptyState
                title="还没有指标快照"
                description="完成真实同步，或在演示模式生成模拟数据后即可查看。"
              />
            ) : (
              <div className="table-scroll" role="region" aria-label="指标快照" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>账号</th>
                      <th>值</th>
                      <th>可用性</th>
                      <th>数据类型</th>
                      <th>来源</th>
                      <th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map((metric) => (
                      <tr key={metric.id}>
                        <td>
                          <span className="cell-title">{metricLabel(metric.metricKey)}</span>
                          <details className="technical-details">
                            <summary>技术详情</summary>
                            <code>{metric.metricKey}</code>
                          </details>
                        </td>
                        <td>
                          <span className="cell-title">{metric.account.displayName}</span>
                          <span className="cell-meta">{platformLabel(metric.account.platform)}</span>
                        </td>
                        <td className="number">
                          {metric.availability === "AVAILABLE" ? metric.numericValue?.toString() ?? "—" : "—"}
                        </td>
                        <td>
                          <StatusIndicator value={metric.availability} compact />
                          {metric.errorMessage ? (
                            <details className="technical-details">
                              <summary>同步错误详情</summary>
                              <p>{metric.errorMessage}</p>
                            </details>
                          ) : null}
                        </td>
                        <td><StatusIndicator value={metric.dataKind} compact /></td>
                        <td>{metricSourceLabel(metric.source)}</td>
                        <td className="number">{formatDateTime(metric.fetchedAt, "—", client.timezone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="section" id="reports">
          <SectionHeader
            title="复盘"
            description="基于已保存数据整理局限、假设和下一步行动。"
            action={(
              <form action="/api/reports" method="post">
                <Button type="submit" size="sm" disabled={!hasWriteAccess}>生成复盘</Button>
              </form>
            )}
          />
          {reports.length === 0 ? (
            <EmptyState
              title="还没有运营复盘"
              description="积累指标和线索后生成第一份复盘，明确下一轮行动。"
            />
          ) : (
            <div className="list">
              {reports.map((report) => (
                <article key={report.id} className="structured-row stack">
                  <div className="toolbar">
                    <div>
                      <strong>{formatDateTime(report.generatedAt, "—", client.timezone)}</strong>
                      <div className="cell-meta">
                        数据周期：{formatDateTime(report.periodStart, "—", client.timezone)} 至 {formatDateTime(report.periodEnd, "—", client.timezone)}
                      </div>
                    </div>
                    <StatusIndicator
                      value={report.simulated ? "MOCK" : "REAL"}
                      label={report.simulated ? "含模拟数据" : "仅真实数据"}
                      compact
                    />
                  </div>
                  <div><strong>业务摘要</strong><p>{reportSummary(report.facts)}</p></div>
                  <div><strong>数据局限</strong><p>{jsonList(report.dataLimitations).join("；") || "当前记录未发现覆盖缺口。"}</p></div>
                  <div><strong>分析假设</strong><p>{jsonList(report.hypotheses).join("；") || "暂无。"}</p></div>
                  <div><strong>建议行动</strong><p>{jsonList(report.recommendations).join("；") || "暂无。"}</p></div>
                  <details className="technical-details">
                    <summary>高级详情：程序计算事实</summary>
                    <pre>{JSON.stringify(report.facts, null, 2)}</pre>
                  </details>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </OperatorShell>
  );
}
