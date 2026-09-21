import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { buildStructuredMemory } from "@/services/memory-service";
import { getBrandProfile } from "@/services/brand-service";

function lines(values: string[] | undefined) {
  return values?.join("\n") || "";
}

export default async function BrandPage() {
  const context = await requirePageContext();
  const [profile, memory] = await Promise.all([getBrandProfile(context), buildStructuredMemory(context)]);
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>品牌系统</h1><p className="muted">结构化品牌事实是内容规划、AI 上下文、Memory 与复盘的共同输入。</p></div></div>
      <div className="grid">
        <section className="card span-8"><h2>Brand Profile</h2><form action="/api/brand" method="post" className="stack">
          <label>业务摘要<textarea name="businessSummary" required defaultValue={profile?.businessSummary || memory.brand.businessSummary} /></label>
          <div className="row"><label>定位<textarea name="positioning" defaultValue={profile?.positioning || ""} /></label><label>受众<textarea name="audience" defaultValue={profile?.audience || ""} /></label></div>
          <div className="row"><label>语气<textarea name="tone" defaultValue={profile?.tone || ""} /></label><label>图像风格<textarea name="imageStyle" defaultValue={profile?.imageStyle || ""} /></label></div>
          <div className="row"><label>Voice traits（每行一条）<textarea name="voiceTraits" defaultValue={lines(profile?.voiceTraits)} /></label><label>目标（每行一条）<textarea name="goals" defaultValue={lines(profile?.goals)} /></label><label>内容语言（每行一条）<textarea name="contentLanguages" defaultValue={lines(profile?.contentLanguages)} /></label></div>
          <div className="row"><label>禁用表达<textarea name="bannedPhrases" defaultValue={lines(profile?.bannedPhrases)} /></label><label>必须提及<textarea name="requiredMentions" defaultValue={lines(profile?.requiredMentions)} /></label><label>CTA 规则<textarea name="ctaRules" defaultValue={lines(profile?.ctaRules)} /></label></div>
          <button>保存 Brand Profile</button>
        </form></section>
        <section className="card span-4"><h2>兼容与来源</h2><div className="stack"><p><span className="badge">{memory.brand.source}</span></p><p className="muted">没有结构化 Profile 时继续读取旧的 <code>Client.brandGuidelines</code>；保存后自动切换为结构化来源，不删除旧字段。</p><div><b>内容记忆：</b>{memory.content.recentPosts.length} 条</div><div><b>表现聚合：</b>{memory.performance.length} 组</div><div><b>研究记录：</b>{memory.research.length} 条</div></div></section>
        <section className="card span-12"><h2>结构化 Memory 预览</h2><div className="grid">
          <div className="span-4"><h3>Content Memory</h3><p className="muted">最近主题、Hook、CTA、产品、平台与时间。</p><pre className="preview">{JSON.stringify(memory.content, null, 2)}</pre></div>
          <div className="span-4"><h3>Performance Memory</h3><p className="muted">只聚合现有 MetricSnapshot，保留 REAL/MOCK 与缺失态。</p><pre className="preview">{JSON.stringify(memory.performance, null, 2)}</pre></div>
          <div className="span-4"><h3>Research Memory</h3><p className="muted">直接读取 ResearchRecord，不创建第二套研究库。</p><pre className="preview">{JSON.stringify(memory.research, null, 2)}</pre></div>
        </div></section>
      </div>
    </OperatorShell>
  );
}
