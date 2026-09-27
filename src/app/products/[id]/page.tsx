import { notFound } from "next/navigation";
import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, SectionHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/presentation/status";

const standardFacts = [
  { key: "material", label: "材质" },
  { key: "dimensions", label: "尺寸" },
  { key: "supply_scope", label: "供货范围" },
] as const;
const labels = Object.fromEntries(standardFacts.map((field) => [field.key, field.label])) as Record<string, string>;

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requirePageContext();
  const { id } = await params;
  const [product, client, contentCount, contentItems] = await Promise.all([
    db.product.findFirst({ where: { id, clientId: context.clientId }, include: {
      fields: { where: { clientId: context.clientId }, orderBy: { key: "asc" } },
      assetLinks: { where: { clientId: context.clientId, asset: { clientId: context.clientId } }, orderBy: { createdAt: "desc" }, take: 30, include: { asset: { select: { id: true, originalName: true, kind: true } } } },
      _count: { select: { assetLinks: { where: { clientId: context.clientId, asset: { clientId: context.clientId } } } } },
    } }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
    db.contentItem.count({ where: { clientId: context.clientId, plan: { clientId: context.clientId, productId: id } } }),
    db.contentItem.findMany({ where: { clientId: context.clientId, plan: { clientId: context.clientId, productId: id } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 20,
      select: { id: true, status: true, updatedAt: true, currentVersion: { select: { version: true, title: true, productDataVersion: true } }, plan: { select: { theme: true } } } }),
  ]);
  if (!product) notFound();
  const canWrite = context.role !== "VIEWER";
  const facts = [
    ...standardFacts.map(({ key }) => product.fields.find((field) => field.key === key) ?? { key, value: null, status: "MISSING" as const, source: null, updatedAt: null }),
    ...product.fields.filter((field) => !standardFacts.some(({ key }) => key === field.key)),
  ];
  const confirmed = product.fields.filter((field) => field.status === "CONFIRMED").length;
  return <OperatorShell context={context}><div className="page">
    <PageHeader title={product.name} eyebrow="产品事实" description={`${product.modelNumber || "未填写型号"} · 当前事实 v${product.dataVersion} · 更新于 ${formatDateTime(product.updatedAt, "—", client.timezone)}`} action={<a className="button button-secondary button-md" href="/products">返回产品列表</a>} />
    <Notice title="事实与历史内容版本">这里只显示当前产品事实。历史内容继续保留创建时的事实快照和产品版本号，不会随产品修改而改写。</Notice>
    <section className="panel"><SectionHeader title="事实核查" description={`已确认 ${confirmed} 项；待确认或缺失的字段不会被 AI 当作已确认的产品事实。`} />
      <div className="table-scroll" role="region" aria-label="产品事实" tabIndex={0}><table style={{ minWidth: 620 }}><thead><tr><th scope="col">字段</th><th scope="col">值</th><th scope="col">来源</th><th scope="col">状态</th><th scope="col">更新</th></tr></thead>
        <tbody>{facts.map((field) => <tr key={field.key}><td><strong>{labels[field.key] || field.key}</strong></td><td>{field.value || "未提供"}</td><td>{field.source || "未记录"}</td><td><StatusIndicator value={field.status} compact /></td><td>{field.updatedAt ? formatDateTime(field.updatedAt, "—", client.timezone) : "—"}</td></tr>)}</tbody></table></div>
      {canWrite ? <details className="disclosure" id="edit-product"><summary>编辑当前产品事实</summary><div className="disclosure-body">
        <Notice title="保存会检查版本" tone="warning">如另一位运营人员已更新 v{product.dataVersion}，系统会要求刷新并核对更改。有实际变化时，未发布的关联内容需要重新审核；进行中或结果不确定的发布任务必须先完成。</Notice>
        <form action={`/api/products/${product.id}`} method="post" className="form-stack">
          <input type="hidden" name="expectedDataVersion" value={product.dataVersion} /><input type="hidden" name="fieldKeys" value={JSON.stringify(facts.map((field) => field.key))} />
          <div className="form-grid"><FormField label="产品名称" htmlFor="edit-product-name"><input id="edit-product-name" name="name" defaultValue={product.name} required /></FormField><FormField label="型号" htmlFor="edit-product-model"><input id="edit-product-model" name="modelNumber" defaultValue={product.modelNumber || ""} /></FormField></div>
          {facts.map((field) => <fieldset className="panel" key={field.key}><legend>{labels[field.key] || field.key}</legend><div className="form-grid">
            <FormField label="事实值" htmlFor={`fact-value-${field.key}`}><input id={`fact-value-${field.key}`} name={`fact_value_${field.key}`} defaultValue={field.value || ""} /></FormField>
            <FormField label="来源" htmlFor={`fact-source-${field.key}`}><input id={`fact-source-${field.key}`} name={`fact_source_${field.key}`} defaultValue={field.source || ""} placeholder="客户文件、邮件或人工确认" /></FormField>
            <FormField label="核查状态" htmlFor={`fact-status-${field.key}`}><select id={`fact-status-${field.key}`} name={`fact_status_${field.key}`} defaultValue={field.status}><option value="MISSING">缺失</option><option value="PROPOSED">待确认</option><option value="CONFIRMED">已确认</option></select></FormField>
          </div></fieldset>)}
          <fieldset className="panel"><legend>新增自定义事实（可选）</legend><div className="form-grid">
            <FormField label="字段键" htmlFor="new-fact-key"><input id="new-fact-key" name="newFactKey" placeholder="例如：certification" pattern="[A-Za-z0-9_\-]+" /></FormField>
            <FormField label="事实值" htmlFor="new-fact-value"><input id="new-fact-value" name="newFactValue" /></FormField>
            <FormField label="来源" htmlFor="new-fact-source"><input id="new-fact-source" name="newFactSource" /></FormField>
            <FormField label="核查状态" htmlFor="new-fact-status"><select id="new-fact-status" name="newFactStatus" defaultValue="PROPOSED"><option value="MISSING">缺失</option><option value="PROPOSED">待确认</option><option value="CONFIRMED">已确认</option></select></FormField>
          </div></fieldset>
          <Button type="submit">保存产品资料</Button>
        </form>
      </div></details> : <Notice title="只读访问">编辑事实需要所有者或运营者权限。</Notice>}
    </section>
    <section className="panel"><SectionHeader title="关联素材" description={`当前共 ${product._count.assetLinks} 个素材；下面最多显示最近 30 个。`} />
      {product.assetLinks.length ? <ul className="asset-list">{product.assetLinks.map(({ asset }) => <li key={asset.id}><a className="text-link" href={`/assets/${asset.id}`}>{asset.originalName}</a><span className="cell-meta">{asset.kind}</span></li>)}</ul> : <EmptyState title="尚未关联素材" description="到素材库上传图片或视频，并选择或关联当前产品。" />}
      <p><a className="text-link" href={`/assets?productId=${product.id}`}>查看或关联更多素材</a></p>
    </section>
    <section className="panel"><SectionHeader title="内容使用" description={`当前有 ${contentCount} 条关联内容；下面最多显示最近 20 条。内容版本的事实快照不可变。`} />
      {contentItems.length ? <div className="content-card-list">{contentItems.map((item) => <article className="content-card" key={item.id}><div className="content-card-main"><a className="content-card-title" href={`/content/${item.id}`}>{item.currentVersion?.title || item.plan.theme}</a><span className="cell-meta">内容 v{item.currentVersion?.version ?? "—"} · 来源产品 v{item.currentVersion?.productDataVersion ?? "—"} · {formatDateTime(item.updatedAt, "—", client.timezone)}</span></div><div className="content-card-meta"><StatusIndicator value={item.status} compact /><span>{item.currentVersion?.productDataVersion === product.dataVersion ? "使用当前产品版本" : "历史产品事实快照"}</span></div></article>)}</div> : <EmptyState title="暂无关联内容" description="确认产品事实后，可从内容中心创建内容。" />}
      <p><a className="text-link" href={`/content?productId=${product.id}`}>打开该产品的内容</a></p>
    </section>
  </div></OperatorShell>;
}
