import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { buildContentMemory, buildPerformanceMemory, buildResearchMemory } from "@/services/memory-service";
import { getBrandProfile } from "@/services/brand-service";

function lines(values: string[] | undefined) {
  return values?.join("\n") || "";
}
export default async function BrandPage() {
  const context = await requirePageContext();
  const [brand, content, performance, research] = await Promise.all([
    getBrandProfile(context),
    buildContentMemory(context, 8),
    buildPerformanceMemory(context, 12),
    buildResearchMemory(context, 8),
  ]);
  return <OperatorShell context={context}>
    <div className="page-title"><div><h1>品牌与知识</h1><p className="muted">结构化品牌资料是 AI 与运营的共同上下文；历史内容、表现与研究继续来自 Aarin 数据库。</p></div></div>
    <div className="grid">
      <section className="card span-7"><h2>Brand Profile</h2><form action="/api/brand" method="post" className="stack">
        <label>业务摘要<textarea name="businessSummary" defaultValue={brand.businessSummary || ""} /></label>
        <label>定位<textarea name="positioning" defaultValue={brand.positioning || ""} /></label>
        <label>目标受众<textarea name="audience" defaultValue={brand.audience || ""} /></label>
        <div className="row"><label>语气<input name="tone" defaultValue={brand.tone || ""} /></label><label>图像风格<input name="imageStyle" defaultValue={brand.imageStyle || ""} /></label></div>
        <div className="row"><label>声音特征（每行一个）<textarea name="voiceTraits" defaultValue={lines(brand.voiceTraits)} /></label><label>业务目标（每行一个）<textarea name="goals" defaultValue={lines(brand.goals)} /></label></div>
        <div className="row"><label>内容语言（每行一个）<textarea name="contentLanguages" defaultValue={lines(brand.contentLanguages)} /></label><label>CTA 规则（每行一个）<textarea name="ctaRules" defaultValue={lines(brand.ctaRules)} /></label></div>
        <div className="row"><label>禁用表达（每行一个）<textarea name="bannedPhrases" defaultValue={lines(brand.bannedPhrases)} /></label><label>必须提及（每行一个）<textarea name="requiredMentions" defaultValue={lines(brand.requiredMentions)} /></label></div>
        <button>保存品牌档案</button>
      </form></section>
      <section className="card span-5"><h2>兼容与上下文</h2><div className="stack"><span className="badge">{brand.source}</span><p>旧品牌规范：{brand.legacyBrandGuidelines || "未配置"}</p><p className="muted">结构化档案为空时仍读取旧字段；新档案不会删除或覆盖 `Client.brandGuidelines`。</p><div className="warning">AI 只能读取已保存的品牌资料与已确认产品事实；这里的保存不会触发审批或发布。</div></div></section>
      <section className="card span-4"><h2>Content Memory</h2><p className="metric">{content.length}</p><p className="muted">最近内容、主题、hook、CTA、产品、平台与时间。</p></section>
      <section className="card span-4"><h2>Performance Memory</h2><p className="metric">{performance.length}</p><p className="muted">来自 MetricSnapshot；不可用数据保持 null，不转成 0。</p></section>
      <section className="card span-4"><h2>Research Memory</h2><p className="metric">{research.length}</p><p className="muted">直接复用 ResearchRecord 的观察、推断、实验与限制。</p></section>
    </div>
  </OperatorShell>;
}
