import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import {
  Button,
  EmptyState,
  FormField,
  Notice,
  PageHeader,
  StatusIndicator,
} from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime, platformLabel, statusLabel } from "@/lib/presentation/status";

const facebookAdvice: Record<string, string> = {
  TOKEN_INVALID: "更新服务器中的 Page token 环境变量，然后重新验证。",
  PERMISSION_DENIED: "检查 Meta App 权限、Page 任务和 App 模式，再重新验证。",
  RATE_LIMITED: "等待限流窗口恢复，避免连续重复操作。",
  NETWORK_TIMEOUT: "检查网络后先查询或人工对账，不要直接重发。",
  CONTENT_REJECTED: "查看 Meta 审核原因，修改内容后重新走人工审批。",
  MEDIA_INVALID: "更换为受支持的 PNG、JPEG、MP4 或 QuickTime 素材并重新审批。",
};

const integrationTypeLabels: Record<string, string> = {
  TEXT_GENERATION: "文本生成",
  IMAGE_GENERATION: "图片生成",
  SOCIAL_PUBLISHING: "社媒发布",
  METRICS: "指标同步",
  INTERACTIONS: "互动同步",
  NOTIFICATION: "通知",
  WORDPRESS: "WordPress",
  OBJECT_STORAGE: "对象存储",
};

const notificationTypeLabels: Record<string, string> = {
  IN_APP: "站内通知",
  URGENT_EXTERNAL: "紧急外部通知",
  EMAIL: "Email",
  WEBHOOK: "Webhook",
};

function integrationTypeLabel(value: string) {
  return integrationTypeLabels[value] ?? value;
}

function notificationTypeLabel(value: string) {
  return notificationTypeLabels[value] ?? value;
}

function providerLabel(value: string) {
  const labels: Record<string, string> = {
    unconfigured: "未配置",
    mock: "模拟 Provider",
    "openai-compatible": "OpenAI-compatible",
  };
  return labels[value] ?? value;
}

function monthStartUtc(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export default async function SettingsPage() {
  const context = await requirePageContext();
  const isOwner = context.role === "OWNER";
  const usageMonthStart = monthStartUtc(new Date());
  const [client, accounts, integrations, usage, channels] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.socialAccount.findMany({
      where: { clientId: context.clientId },
      include: { facebookConnection: true },
      orderBy: [{ platform: "asc" }, { displayName: "asc" }],
    }),
    db.integrationConfig.findMany({
      where: { clientId: context.clientId },
      orderBy: { type: "asc" },
    }),
    db.usageLog.aggregate({
      where: {
        clientId: context.clientId,
        createdAt: { gte: usageMonthStart },
        simulated: false,
      },
      _sum: { inputUnits: true, outputUnits: true },
    }),
    db.notificationChannel.findMany({
      where: { clientId: context.clientId },
      orderBy: { type: "asc" },
    }),
  ]);

  const contact = (client.contactDetails || {}) as Record<string, unknown>;
  const textIntegration = integrations.find(
    (integration) => integration.type === "TEXT_GENERATION" && integration.status === "VERIFIED",
  ) || integrations.find((integration) => integration.type === "TEXT_GENERATION");
  const facebookAccounts = accounts.filter((account) => account.platform === "facebook");
  const currentUsage = (usage._sum.inputUnits || 0) + (usage._sum.outputUnits || 0);
  const realTextProviderVerified = textIntegration?.provider === "openai-compatible"
    && textIntegration.status === "VERIFIED";

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader
          title="设置"
          description="管理工作区、运行模式、用量和集成边界。"
          action={(
            <Button
              type="submit"
              form="workspace-settings-form"
              disabled={!isOwner}
            >
              保存设置
            </Button>
          )}
        />

        {context.role !== "OWNER" ? (
          <Notice title="只读访问" tone="warning">
            只有工作区所有者可以保存设置；你仍可查看当前配置状态。
          </Notice>
        ) : null}

        <form
          id="workspace-settings-form"
          action="/api/settings"
          method="post"
          className="settings-sections"
        >
          <section className="settings-section" id="settings-workspace">
            <div className="settings-section-copy">
              <h2>工作区</h2>
              <p>工作区名称和本地显示时区。</p>
            </div>
            <div className="form-stack">
              <FormField label="工作区名称" htmlFor="settings-workspace-name">
                <input id="settings-workspace-name" value={client.name} readOnly />
              </FormField>
              <FormField label="时区" htmlFor="settings-timezone">
                <input id="settings-timezone" name="timezone" defaultValue={client.timezone} disabled={!isOwner} />
              </FormField>
            </div>
          </section>

          <section className="settings-section" id="settings-market-brand">
            <div className="settings-section-copy">
              <h2>市场与品牌</h2>
              <p>定义内容使用的目标市场、事实范围和品牌表达。</p>
            </div>
            <div className="form-stack">
              <FormField
                label="目标国家"
                htmlFor="settings-target-markets"
                helper="使用英文逗号分隔；尚未确认的市场保持为空。"
              >
                <input
                  id="settings-target-markets"
                  name="targetMarkets"
                  defaultValue={client.targetMarkets.join(", ")}
                  aria-describedby="settings-target-markets-helper"
                  disabled={!isOwner}
                />
              </FormField>
              <FormField label="产品重点" htmlFor="settings-product-focus">
                <textarea
                  id="settings-product-focus"
                  name="productFocus"
                  defaultValue={client.productFocus || ""}
                  disabled={!isOwner}
                />
              </FormField>
              <FormField label="品牌表达规范" htmlFor="settings-brand-guidelines">
                <textarea
                  id="settings-brand-guidelines"
                  name="brandGuidelines"
                  defaultValue={client.brandGuidelines || ""}
                  disabled={!isOwner}
                />
              </FormField>
              <div className="form-grid">
                <FormField label="网站" htmlFor="settings-website">
                  <input
                    id="settings-website"
                    name="website"
                    type="url"
                    defaultValue={String(contact.website || "")}
                    disabled={!isOwner}
                  />
                </FormField>
                <FormField label="WhatsApp" htmlFor="settings-whatsapp">
                  <input
                    id="settings-whatsapp"
                    name="whatsapp"
                    defaultValue={String(contact.whatsapp || "")}
                    disabled={!isOwner}
                  />
                </FormField>
              </div>
            </div>
          </section>

          <section className="settings-section" id="settings-runtime">
            <div className="settings-section-copy">
              <h2>运行模式</h2>
              <p>控制工作区是否允许进入真实发布流程。</p>
            </div>
            <div className="form-stack">
              <StatusIndicator value={client.mode} label={`当前：${client.mode === "LIVE" ? "正式" : client.mode === "DEMO" ? "演示" : "草稿"}`} />
              <FormField label="模式" htmlFor="settings-mode">
                <select id="settings-mode" name="mode" defaultValue={client.mode} disabled={!isOwner}>
                  <option value="DEMO">演示模式</option>
                  <option value="DRAFT">草稿模式</option>
                  <option value="LIVE">正式模式</option>
                </select>
              </FormField>
              <Notice title="正式模式" tone="warning">
                切换到正式模式不会跳过审核、账号能力验证或发布安全规则。
              </Notice>
            </div>
          </section>

          <section className="settings-section" id="settings-usage">
            <div className="settings-section-copy">
              <h2>用量</h2>
              <p>查看当前 UTC 自然月的真实模型用量，并设置工作区月度上限。</p>
            </div>
            <div className="form-stack">
              <div>
                <span className="muted">本月真实用量</span>
                <strong className="metric number">{currentUsage}</strong>
              </div>
              <FormField label="每月模型用量上限（单位）" htmlFor="settings-usage-limit">
                <input
                  id="settings-usage-limit"
                  name="usageMonthlyLimit"
                  type="number"
                  min="0"
                  defaultValue={client.usageMonthlyLimit}
                  disabled={!isOwner}
                />
              </FormField>
              <p className="field-helper">仅成功完成的真实模型调用计入用量，失败调用不计入。</p>
            </div>
          </section>

          <section className="settings-section" id="settings-integrations">
            <div className="settings-section-copy">
              <h2>集成</h2>
              <p>选择文本生成 Provider，并确认真实连接的数据边界。</p>
            </div>
            <div className="form-stack">
              <div className="toolbar">
                <span className="muted">当前文本生成连接</span>
                <StatusIndicator value={textIntegration?.status} compact />
              </div>
              <FormField label="文本生成 Provider" htmlFor="settings-text-provider">
                <select
                  id="settings-text-provider"
                  name="textProvider"
                  defaultValue={textIntegration?.provider || "unconfigured"}
                  disabled={!isOwner}
                >
                  <option value="unconfigured">未配置（使用模拟）</option>
                  <option value="mock">固定模拟生成</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              </FormField>
              <label className="account-option" htmlFor="settings-text-provider-verified">
                <input
                  id="settings-text-provider-verified"
                  name="confirmTextModelVerified"
                  type="checkbox"
                  value="true"
                  defaultChecked={realTextProviderVerified}
                  disabled={!isOwner}
                />
                <span>
                  <strong>真实模型连接已验证</strong>
                  <span className="cell-meta">确认服务端凭据完整，并已核对数据使用边界。</span>
                </span>
              </label>
              <p className="field-helper">
                密钥只从服务端环境变量读取。未确认验证时，真实 Provider 会保持未验证状态。
              </p>
            </div>
          </section>

          <section className="settings-section" id="settings-notifications">
            <div className="settings-section-copy">
              <h2>通知</h2>
              <p>设置人工通知联系人并查看通道可用性。</p>
            </div>
            <div className="form-stack">
              <FormField label="通知联系人或通道说明" htmlFor="settings-notification-contact">
                <input
                  id="settings-notification-contact"
                  name="notificationContact"
                  defaultValue={String(contact.notificationContact || "")}
                  disabled={!isOwner}
                />
              </FormField>
              {channels.length === 0 ? (
                <EmptyState title="还没有通知通道" description="重要事件会继续保留为站内任务。" />
              ) : (
                <div className="table-scroll" role="region" aria-label="通知通道" tabIndex={0}>
                  <table>
                    <thead>
                      <tr><th>类型</th><th>名称</th><th>状态</th><th>验证时间</th></tr>
                    </thead>
                    <tbody>
                      {channels.map((channel) => (
                        <tr key={channel.id}>
                          <td>{notificationTypeLabel(channel.type)}</td>
                          <td>{channel.displayName}</td>
                          <td><StatusIndicator value={channel.status} compact /></td>
                          <td>{formatDateTime(channel.verifiedAt, "未验证", client.timezone)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="field-helper">未配置外部通道时，事件只会创建站内通知和人工任务。</p>
            </div>
          </section>

          <section className="settings-section" id="settings-advanced">
            <div className="settings-section-copy">
              <h2>高级</h2>
              <p>查看账号能力和适配器状态。日常运营通常无需调整。</p>
            </div>
            <div className="form-stack">
              <details className="disclosure">
                <summary>账号能力</summary>
                <div className="disclosure-body table-scroll" role="region" aria-label="账号能力" tabIndex={0}>
                  <table>
                    <thead>
                      <tr><th>平台与账号</th><th>发布</th><th>指标</th><th>评论</th><th>私信</th><th>群组</th></tr>
                    </thead>
                    <tbody>
                      {accounts.map((account) => (
                        <tr key={account.id}>
                          <td>
                            <span className="cell-title">{account.displayName}</span>
                            <span className="cell-meta">{platformLabel(account.platform)}</span>
                          </td>
                          <td><StatusIndicator value={account.publishCapability} compact /></td>
                          <td><StatusIndicator value={account.metricsCapability} compact /></td>
                          <td><StatusIndicator value={account.commentsCapability} compact /></td>
                          <td><StatusIndicator value={account.messagesCapability} compact /></td>
                          <td><StatusIndicator value={account.groupsCapability} compact /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              <details className="disclosure">
                <summary>适配器状态</summary>
                <div className="disclosure-body table-scroll" role="region" aria-label="适配器状态" tabIndex={0}>
                  <table>
                    <thead>
                      <tr><th>能力</th><th>Provider</th><th>状态</th><th>凭据</th><th>验证时间</th></tr>
                    </thead>
                    <tbody>
                      {integrations.map((integration) => (
                        <tr key={integration.id}>
                          <td>{integrationTypeLabel(integration.type)}</td>
                          <td>{providerLabel(integration.provider)}</td>
                          <td><StatusIndicator value={integration.status} compact /></td>
                          <td>{integration.credentialRef ? "已配置" : "未配置"}</td>
                          <td>{formatDateTime(integration.verifiedAt, "未验证", client.timezone)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </section>
        </form>

        <details className="disclosure" id="legacy-facebook">
          <summary>高级：Legacy Facebook connection</summary>
          <div className="disclosure-body stack">
            <Notice title="兼容连接">
              新连接请优先使用 <Link className="text-link" href="/connections">平台连接</Link> 完成 Meta OAuth。
              此处仅用于迁移兼容和专用测试 Page 的环境变量引用方式。
            </Notice>

            {facebookAccounts.length === 0 ? (
              <EmptyState
                title="没有 Facebook 账号"
                description="先在平台连接中发现并选择 Facebook Page。"
              />
            ) : (
              <div className="list">
                {facebookAccounts.map((account) => {
                  const facebook = account.facebookConnection;
                  const accountPrefix = `legacy-facebook-${account.id}`;
                  return (
                    <article className="structured-row stack" key={account.id}>
                      <div className="toolbar">
                        <div>
                          <strong>{account.displayName}</strong>
                          <div className="cell-meta">
                            {platformLabel(account.platform)} · {account.externalAccountId || "尚无远端账号 ID"}
                          </div>
                        </div>
                        <div className="actions">
                          <StatusIndicator
                            value={facebook?.connectionStatus || "UNCONFIGURED"}
                            label={`连接：${statusLabel(facebook?.connectionStatus || "UNCONFIGURED")}`}
                            compact
                          />
                          <StatusIndicator
                            value={facebook?.tokenStatus || "UNCONFIGURED"}
                            label={`凭据：${statusLabel(facebook?.tokenStatus || "UNCONFIGURED")}`}
                            compact
                          />
                        </div>
                      </div>

                      <div className="split-layout">
                        <form action="/api/facebook/connection" method="post" className="form-stack">
                          <input type="hidden" name="accountId" value={account.id} />
                          <div className="form-grid">
                            <FormField label="Page ID" htmlFor={`${accountPrefix}-page-id`}>
                              <input
                                id={`${accountPrefix}-page-id`}
                                name="pageId"
                                required
                                defaultValue={facebook?.pageId || ""}
                                placeholder="仅数字"
                                disabled={!isOwner}
                              />
                            </FormField>
                            <FormField label="Graph API 版本" htmlFor={`${accountPrefix}-api-version`}>
                              <input
                                id={`${accountPrefix}-api-version`}
                                name="graphApiVersion"
                                required
                                defaultValue={facebook?.graphApiVersion || process.env.FACEBOOK_GRAPH_API_VERSION || "v26.0"}
                                disabled={!isOwner}
                              />
                            </FormField>
                            <FormField
                              label="Page token 环境变量引用"
                              htmlFor={`${accountPrefix}-credential-ref`}
                              className="span-full"
                            >
                              <input
                                id={`${accountPrefix}-credential-ref`}
                                name="credentialRef"
                                required
                                defaultValue={facebook?.credentialRef || "env:FACEBOOK_TEST_PAGE_ACCESS_TOKEN"}
                                pattern="env:FACEBOOK_[A-Z0-9_]+"
                                disabled={!isOwner}
                              />
                            </FormField>
                            <FormField
                              label="所需权限（逗号分隔）"
                              htmlFor={`${accountPrefix}-permissions`}
                              className="span-full"
                            >
                              <input
                                id={`${accountPrefix}-permissions`}
                                name="requiredPermissions"
                                defaultValue={(facebook?.requiredPermissions || [
                                  "pages_manage_posts",
                                  "pages_read_engagement",
                                  "pages_read_user_content",
                                ]).join(",")}
                                disabled={!isOwner}
                              />
                            </FormField>
                            <FormField
                              label="Page 指标（逗号分隔）"
                              htmlFor={`${accountPrefix}-metrics`}
                              helper="仅填写当前 Graph API 实际支持的指标名。"
                              className="span-full"
                            >
                              <input
                                id={`${accountPrefix}-metrics`}
                                name="metricKeys"
                                defaultValue={facebook?.metricKeys.join(",") || ""}
                                aria-describedby={`${accountPrefix}-metrics-helper`}
                                disabled={!isOwner}
                              />
                            </FormField>
                          </div>
                          <Button type="submit" disabled={!isOwner}>
                            保存配置（之后重新验证）
                          </Button>
                        </form>

                        <div className="form-stack">
                          <div className="facts">
                            <span className="muted">Page</span>
                            <span>{facebook?.pageName || "未验证"}</span>
                            <span />
                            <span className="muted">最近验证</span>
                            <span>{formatDateTime(facebook?.lastCheckedAt, "—", client.timezone)}</span>
                            <span />
                          </div>
                          {facebook?.lastErrorCategory ? (
                            <Notice title="连接需要处理" tone="danger">
                              {facebook.lastErrorMessage || "连接验证失败。"}<br />
                              {facebookAdvice[facebook.lastErrorCategory] || "请在 Meta 后台核对连接状态。"}
                            </Notice>
                          ) : null}
                          <form action="/api/facebook/connection/validate" method="post">
                            <input type="hidden" name="accountId" value={account.id} />
                            <Button
                              type="submit"
                              variant="secondary"
                              disabled={!facebook || context.role === "VIEWER"}
                            >
                              验证此 Page
                            </Button>
                          </form>
                          <details className="technical-details">
                            <summary>技术详情</summary>
                            <p>已授予权限：{facebook?.grantedPermissions.join(", ") || "未读取"}</p>
                            <p>Page tasks：{facebook?.pageTasks.join(", ") || "未读取"}</p>
                            {facebook?.lastErrorCategory ? <p>错误代码：<code>{facebook.lastErrorCategory}</code></p> : null}
                          </details>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </details>
      </div>
    </OperatorShell>
  );
}
