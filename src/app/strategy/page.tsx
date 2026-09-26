import { OperatorShell } from "@/components/operator-shell";
import { Button, Notice, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { listSocialStrategies, socialStrategyPayloadSchema } from "@/services/social-strategy-service";

function date(value: Date | null) { return value?.toISOString().slice(0, 10) || ""; }
function lines(values: string[]) { return values.join("\n"); }
function weighted(values: Array<{ name: string; percentage: number }>) {
  return values.map((item) => `${item.name} | ${item.percentage}`).join("\n");
}

export default async function StrategyPage() {
  const context = await requirePageContext();
  const [strategies, client] = await Promise.all([
    listSocialStrategies(context),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { name: true, mode: true, targetMarkets: true } }),
  ]);
  const draft = strategies.find((item) => item.status === "DRAFT");
  const confirmed = strategies.find((item) => item.status === "CONFIRMED");
  const payload = socialStrategyPayloadSchema.parse((draft || confirmed)?.payload || {});
  const readOnly = context.role === "VIEWER";
  const fields = [
    { name: "businessGoal", label: "业务目标", value: payload.businessGoal },
    { name: "primaryBuyer", label: "主要 Buyer", value: payload.primaryBuyer },
    { name: "targetMarkets", label: "目标市场（每行一个）", value: lines(payload.targetMarkets) },
    { name: "platformRoles", label: "平台角色（每行：平台 | 角色）", value: payload.platformRoles.map((item) => `${item.platform} | ${item.role}`).join("\n") },
    { name: "contentPillars", label: "内容支柱（每行：名称 | 百分比）", value: weighted(payload.contentPillars) },
    { name: "formatMix", label: "内容形式（每行：名称 | 百分比）", value: weighted(payload.formatMix) },
    { name: "postingCadence", label: "发布节奏", value: payload.postingCadence },
    { name: "coreMessage", label: "核心信息", value: payload.coreMessage },
    { name: "ctaGuidance", label: "CTA 建议（每行一个）", value: lines(payload.ctaGuidance) },
    { name: "priorityProducts", label: "重点产品（每行一个）", value: lines(payload.priorityProducts) },
    { name: "assetPriorities", label: "素材优先级（每行一个）", value: lines(payload.assetPriorities) },
    { name: "experiments", label: "本周期实验（每行一个）", value: lines(payload.experiments) },
    { name: "limitations", label: "限制与假设（每行一个）", value: lines(payload.limitations) },
  ];
  return <OperatorShell context={context}>
    <div className="page">
      <PageHeader title="运营策略" eyebrow={client.name} description="记录本运营周期的 Buyer、市场、平台和内容选择。产品已确认事实与 BrandProfile 硬规则始终优先。" />
      {client.mode === "LIVE" && !confirmed ? <Notice title="AI 内容生成需要确认策略" tone="warning">LIVE 客户的 AI 初始生成需要确认版。已有内容的人工操作继续可用。</Notice> : null}
      {readOnly ? <Notice title="只读访问">你可以查看策略；创建和确认需要运营权限。</Notice> : null}
      <div className="grid">
        <section className="card span-8"><h2>{draft ? `编辑草稿 v${draft.version}` : "新建策略草稿"}</h2>
          <p className="muted">每次保存都会创建新的不可变草稿版本；草稿不会自动确认。</p>
          {!readOnly ? <form action="/api/social-strategies" method="post" className="form-stack">
            <div className="form-grid">
              {fields.map((field) => <label key={field.name}>{field.label}<textarea name={field.name} defaultValue={field.value} /></label>)}
              <label>有效期开始（可空）<input type="date" name="effectiveFrom" defaultValue={date(draft?.effectiveFrom || confirmed?.effectiveFrom || null)} /></label>
              <label>有效期结束（可空）<input type="date" name="effectiveTo" defaultValue={date(draft?.effectiveTo || confirmed?.effectiveTo || null)} /></label>
            </div>
            <p className="field-helper">企业默认市场：{client.targetMarkets.join("、") || "未设置"}；策略市场需人工保存。平台可用 facebook、instagram、tiktok、linkedin；BrandProfile.ctaRules 始终优先于 CTA 建议。</p>
            <div className="actions"><Button type="submit">保存为新草稿版本</Button></div>
          </form> : null}
        </section>
        <section className="card span-4"><h2>当前版本</h2><div className="stack-tight">
          <p>已确认：{confirmed ? `v${confirmed.version}` : "无"}</p>
          <p>待确认草稿：{draft ? `v${draft.version}` : "无"}</p>
          {draft && !readOnly ? <form action={`/api/social-strategies/${draft.id}/confirm`} method="post"><Button type="submit">人工确认 v{draft.version}</Button></form> : null}
          <p className="muted">确认时在 AuditLog 记录品牌资料更新时间和企业默认市场快照。有效期只标识月度或阶段。</p>
        </div></section>
        <section className="card span-12"><h2>版本历史</h2>
          {strategies.length ? <ul className="stack-tight">{strategies.map((item) => <li key={item.id}>v{item.version} · {item.status} · {date(item.effectiveFrom) || "未设开始"} 至 {date(item.effectiveTo) || "未设结束"}</li>)}</ul> : <p className="muted">尚无策略版本。</p>}
        </section>
      </div>
    </div>
  </OperatorShell>;
}
