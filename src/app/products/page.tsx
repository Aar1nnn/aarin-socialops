import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, StatusIndicator } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/presentation/status";

const initialFacts = [
  { key: "material", label: "材质" },
  { key: "dimensions", label: "尺寸" },
  { key: "supply_scope", label: "供货范围" },
] as const;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const PAGE_SIZE = 24;

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; page?: string | string[]; create?: string | string[] }> }) {
  const context = await requirePageContext();
  const params = await searchParams;
  const q = (first(params.q) || "").trim().slice(0, 100);
  const page = Math.min(1000, Math.max(1, Number.parseInt(first(params.page) || "1", 10) || 1));
  const canWrite = context.role !== "VIEWER";
  const where = { clientId: context.clientId, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { modelNumber: { contains: q, mode: "insensitive" as const } }] } : {}) };
  const [products, total, client] = await Promise.all([
    db.product.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      include: { fields: { where: { clientId: context.clientId }, select: { key: true, value: true, status: true, source: true } },
        _count: { select: { assetLinks: { where: { clientId: context.clientId, asset: { clientId: context.clientId } } }, plans: { where: { clientId: context.clientId } } } } } }),
    db.product.count({ where }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  const href = (target: number) => `/products?${new URLSearchParams({ ...(q ? { q } : {}), page: String(target) }).toString()}`;
  return <OperatorShell context={context}><div className="page">
    <PageHeader title="产品资料" description="逐项核对产品事实、来源和关联内容；只有已确认的字段能作为 AI 产品事实。" action={canWrite ? <a className="button button-primary button-md" href="/products?create=1#create-product">添加产品</a> : undefined} />
    {canWrite ? <details className="disclosure" id="create-product" open={total === 0 || first(params.create) === "1"}>
      <summary>添加产品</summary><form action="/api/products" method="post" className="disclosure-body form-stack form-width">
        <div className="form-grid"><FormField label="产品名称" htmlFor="new-product-name"><input id="new-product-name" name="name" required /></FormField><FormField label="型号" htmlFor="new-product-model"><input id="new-product-model" name="modelNumber" /></FormField></div>
        {initialFacts.map(({ key, label }) => <div className="form-grid" key={key}>
          <FormField label={label} htmlFor={`new-${key}`}><input id={`new-${key}`} name={key} /></FormField>
          <FormField label={`${label}来源`} htmlFor={`new-${key}-source`} helper="确认事实必须记录客户文件或人工确认来源。"><input id={`new-${key}-source`} name={`${key}_source`} /></FormField>
          <label className="row"><input type="checkbox" name={`${key}_confirmed`} value="on" style={{ width: "auto", minHeight: 0 }} />已核对</label>
        </div>)}
        <Button type="submit">保存产品</Button>
      </form>
    </details> : <Notice title="只读访问">当前角色可以检查产品资料，编辑需要所有者或运营者权限。</Notice>}
    <section className="panel"><form action="/products" method="get" className="row" style={{ flexWrap: "wrap" }}>
      <FormField label="查找产品或型号" htmlFor="product-search"><input id="product-search" name="q" type="search" defaultValue={q} /></FormField><Button type="submit" variant="secondary">查找</Button>
    </form></section>
    <section className="panel"><div className="section-header"><div><h2>产品列表</h2><p className="muted">{total} 个产品 · 第 {page} 页 · 当前事实不等于历史内容版本的事实快照。</p></div><a className="text-link" href="/assets">打开素材库</a></div>
      {products.length === 0 ? <EmptyState title={q ? "没有匹配的产品" : "还没有产品"} description={q ? "调整搜索词后重试。" : "先添加产品并确认有来源的事实，再创建内容。"} /> : <div className="content-card-list">
        {products.map((product) => {
          const confirmed = product.fields.filter((field) => field.status === "CONFIRMED").length;
          const proposed = product.fields.filter((field) => field.status === "PROPOSED").length;
          const missing = initialFacts.filter(({ key }) => !product.fields.some((field) => field.key === key)).length + product.fields.filter((field) => field.status === "MISSING").length;
          return <article className="content-card" key={product.id}>
            <div className="content-card-main"><a className="content-card-title" href={`/products/${product.id}`}>{product.name}</a><p>{product.modelNumber || "未填写型号"} · 当前事实 v{product.dataVersion}</p><span className="cell-meta">更新于 {formatDateTime(product.updatedAt, "—", client.timezone)}</span></div>
            <div className="content-card-meta"><span>已确认 {confirmed} · 待确认 {proposed} · 缺失 {missing}</span><span>关联素材 {product._count.assetLinks} · 内容计划 {product._count.plans}</span><StatusIndicator value={confirmed > 0 ? "CONFIRMED" : proposed > 0 ? "PROPOSED" : "MISSING"} compact /></div>
            <a className="button button-secondary button-sm" href={`/products/${product.id}`}>核对事实</a>
          </article>;
        })}
      </div>}
      {total > PAGE_SIZE ? <nav className="row" aria-label="产品翻页" style={{ justifyContent: "space-between" }}><span>{page > 1 ? <a className="text-link" href={href(page - 1)}>上一页</a> : null}</span><span>{page * PAGE_SIZE < total ? <a className="text-link" href={href(page + 1)}>下一页</a> : null}</span></nav> : null}
    </section>
    <span id="upload-asset"><a className="text-link" href="/assets#upload-asset">上传素材或查看素材使用情况</a></span>
  </div></OperatorShell>;
}
