import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import Link from "next/link";

const facebookAdvice: Record<string, string> = {
  TOKEN_INVALID: "更新服务器中的 Page token 环境变量，然后重新验证。",
  PERMISSION_DENIED: "检查 Meta App 权限、Page 任务和 App 模式，再重新验证。",
  RATE_LIMITED: "等待限流窗口恢复，避免连续重复操作。",
  NETWORK_TIMEOUT: "检查网络后先查询或人工对账，不要直接重发。",
  CONTENT_REJECTED: "查看 Meta 审核原因，修改内容后重新走人工审批。",
  MEDIA_INVALID: "更换为受支持的 PNG、JPEG、MP4 或 QuickTime 素材并重新审批。",
};

export default async function SettingsPage() {
  const context = await requirePageContext();
  const [client, accounts, integrations, usage, channels] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: context.clientId } }),
    db.socialAccount.findMany({ where: { clientId: context.clientId }, include: { facebookConnection: true }, orderBy: { platform: "asc" } }),
    db.integrationConfig.findMany({ where: { clientId: context.clientId }, orderBy: { type: "asc" } }),
    db.usageLog.aggregate({ where: { clientId: context.clientId }, _sum: { inputUnits: true, outputUnits: true } }),
    db.notificationChannel.findMany({ where: { clientId: context.clientId }, orderBy: { type: "asc" } }),
  ]);
  const contact = (client.contactDetails || {}) as Record<string, unknown>;
  const textIntegration = integrations.find((integration) => integration.type === "TEXT_GENERATION" && integration.status === "VERIFIED") || integrations.find((integration) => integration.type === "TEXT_GENERATION");
  const facebookAccount = accounts.find((account) => account.platform === "facebook");
  const facebook = facebookAccount?.facebookConnection;
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>设置</h1><p className="muted">只记录配置状态和凭据引用；密钥不会进入页面、日志或 prompt。</p></div></div>
      <div className="grid">
        <section className="card span-7"><h2>客户与运行模式</h2><form action="/api/settings" method="post" className="stack">
          <label>客户名称<input value={client.name} readOnly /></label>
          <div className="row"><label>运行模式<select name="mode" defaultValue={client.mode}><option value="DEMO">演示模式</option><option value="DRAFT">草稿模式</option><option value="LIVE">正式模式</option></select></label><label>时区<input name="timezone" defaultValue={client.timezone} /></label></div>
          <label>目标国家（逗号分隔）<input name="targetMarkets" defaultValue={client.targetMarkets.join(", ")} placeholder="未确认时保持为空" /></label>
          <label>产品重点<textarea name="productFocus" defaultValue={client.productFocus || ""} /></label>
          <label>品牌表达规范<textarea name="brandGuidelines" defaultValue={client.brandGuidelines || ""} /></label>
          <div className="row"><label>网站<input name="website" defaultValue={String(contact.website || "")} /></label><label>WhatsApp<input name="whatsapp" defaultValue={String(contact.whatsapp || "")} /></label></div>
          <label>通知联系人/通道说明<input name="notificationContact" defaultValue={String(contact.notificationContact || "")} /></label>
          <label>每月模型用量上限（单位）<input name="usageMonthlyLimit" type="number" min="0" defaultValue={client.usageMonthlyLimit} /></label>
          <div className="row"><label>文本生成 Provider<select name="textProvider" defaultValue={textIntegration?.provider || "unconfigured"}><option value="unconfigured">未配置（使用模拟）</option><option value="mock">固定模拟生成</option><option value="openai-compatible">OpenAI-compatible</option></select></label><label><input name="confirmTextModelVerified" type="checkbox" value="true" /> 已完成真实模型连接与数据边界验证</label></div>
          <p className="muted">真实密钥只从服务端环境变量读取。未勾选验证或变量不完整时，状态保持 UNVERIFIED，业务不会向真实模型发送资料。</p>
          <button disabled={context.role !== "OWNER"}>保存设置</button>
        </form></section>
        <section className="card span-5"><h2>使用量</h2><div className="metric">{(usage._sum.inputUnits || 0) + (usage._sum.outputUnits || 0)}</div><p className="muted">输入与输出单位合计；上限 {client.usageMonthlyLimit}。真实调用会先事务性预占，成功结算，失败释放。</p><div className="warning">切换到正式模式不会绕过适配器验证。只有已验证 Facebook Page 可进入 LIVE 队列。</div></section>
        <section className="card span-12"><h2>Facebook Page 手工连接（V1 fallback）</h2><p className="muted">新连接请优先使用 <Link href="/connections">平台连接</Link> 的 Meta OAuth。此处只保留迁移兼容和专用测试 Page 的环境变量引用方式。</p>{facebookAccount ? <div className="grid">
          <form action="/api/facebook/connection" method="post" className="stack span-7">
            <input type="hidden" name="accountId" value={facebookAccount.id} />
            <div className="row"><label>Page ID<input name="pageId" required defaultValue={facebook?.pageId || ""} placeholder="仅数字" /></label><label>Graph API 版本<input name="graphApiVersion" required defaultValue={facebook?.graphApiVersion || process.env.FACEBOOK_GRAPH_API_VERSION || "v26.0"} /></label></div>
            <label>Page token 环境变量引用<input name="credentialRef" required defaultValue={facebook?.credentialRef || "env:FACEBOOK_TEST_PAGE_ACCESS_TOKEN"} pattern="env:FACEBOOK_[A-Z0-9_]+" /></label>
            <label>所需权限（逗号分隔）<input name="requiredPermissions" defaultValue={(facebook?.requiredPermissions || ["pages_manage_posts", "pages_read_engagement", "pages_read_user_content"]).join(",")} /></label>
            <label>要读取的 Page 指标（逗号分隔）<input name="metricKeys" defaultValue={facebook?.metricKeys.join(",") || ""} placeholder="只填写当前 Graph API 实际支持的指标名" /></label>
            <button disabled={context.role !== "OWNER"}>保存非敏感配置（保存后需重新验证）</button>
          </form>
          <div className="stack span-5">
            <div className={facebook?.connectionStatus === "VERIFIED" ? "warning" : "error"}>连接：{facebook?.connectionStatus || "UNCONFIGURED"} · 令牌：{facebook?.tokenStatus || "UNCONFIGURED"}</div>
            <p>Page：{facebook?.pageName || "未验证"} {facebook?.pageId ? `(${facebook.pageId})` : ""}</p>
            <p className="muted">已授予权限：{facebook?.grantedPermissions.join(", ") || "未读取"}</p>
            <p className="muted">Page tasks：{facebook?.pageTasks.join(", ") || "未读取"}</p>
            <p className="muted">最近验证：{facebook?.lastCheckedAt?.toLocaleString("zh-CN") || "—"}</p>
            {facebook?.lastErrorCategory && <div className="error">{facebook.lastErrorCategory}：{facebook.lastErrorMessage}<br />处理建议：{facebookAdvice[facebook.lastErrorCategory] || "记录错误代码并在 Meta 后台核对连接状态。"}</div>}
            <form action="/api/facebook/connection/validate" method="post"><input type="hidden" name="accountId" value={facebookAccount.id} /><button disabled={!facebook}>连接并验证 Page</button></form>
            <p className="muted">令牌值只从服务器环境变量读取，数据库和页面仅保存引用。私信、群组、自动回复保持禁用。</p>
          </div>
        </div> : <p className="muted">当前客户没有 Facebook 账号记录。</p>}</section>
        <section className="card span-12"><h2>账号能力矩阵</h2><table><thead><tr><th>平台/账号</th><th>发布</th><th>指标</th><th>评论</th><th>私信</th><th>群组</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td>{account.platform}<br /><small>{account.displayName}</small></td><td>{account.publishCapability}</td><td>{account.metricsCapability}</td><td>{account.commentsCapability}</td><td>{account.messagesCapability}</td><td>{account.groupsCapability}</td></tr>)}</tbody></table><p className="muted">不支持或未验证能力会转为人工任务；不承诺自动找全群组、自动入群或发帖。</p></section>
        <section className="card span-12"><h2>适配器状态</h2><table><thead><tr><th>能力</th><th>Provider</th><th>状态</th><th>凭据引用</th><th>验证时间</th></tr></thead><tbody>{integrations.map((integration) => <tr key={integration.id}><td>{integration.type}</td><td>{integration.provider}</td><td>{integration.status}</td><td>{integration.credentialRef ? "已配置（值不展示）" : "未配置"}</td><td>{integration.verifiedAt?.toLocaleString("zh-CN") || "—"}</td></tr>)}</tbody></table></section>
        <section className="card span-12"><h2>通知通道</h2><table><thead><tr><th>类型</th><th>名称</th><th>状态</th><th>验证时间</th></tr></thead><tbody>{channels.map((channel) => <tr key={channel.id}><td>{channel.type}</td><td>{channel.displayName}</td><td>{channel.status}</td><td>{channel.verifiedAt?.toLocaleString("zh-CN") || "未验证"}</td></tr>)}</tbody></table><p className="muted">外部通道未配置时，重要事件只创建站内通知和人工任务，不会显示为已送达。</p></section>
      </div>
    </OperatorShell>
  );
}
