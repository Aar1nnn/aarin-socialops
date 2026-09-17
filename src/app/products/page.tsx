import { OperatorShell } from "@/components/operator-shell";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function ProductsPage() {
  const context = await requirePageContext();
  const [products, assets] = await Promise.all([
    db.product.findMany({ where: { clientId: context.clientId }, include: { fields: true, assetLinks: true }, orderBy: { updatedAt: "desc" } }),
    db.asset.findMany({ where: { clientId: context.clientId }, include: { productLinks: { include: { product: true } } }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <OperatorShell context={context}>
      <div className="page-title"><div><h1>产品与素材</h1><p className="muted">推测字段不会自动成为确认事实；每个确认字段都应记录来源。</p></div></div>
      <div className="grid">
        <section className="card span-6"><h2>创建产品</h2><form action="/api/products" method="post" className="stack">
          <div className="row"><label>产品名称<input name="name" required /></label><label>型号<input name="modelNumber" /></label></div>
          {[
            ["material", "材质"], ["dimensions", "尺寸"], ["supply_scope", "供货范围"],
          ].map(([key, label]) => <div key={key} className="row"><label>{label}<input name={key} /></label><label>来源<input name={`${key}_source`} placeholder="客户表格/文件名/人工确认" /></label><label style={{ flex: "0 0 100px" }}>已确认<input type="checkbox" name={`${key}_confirmed`} /></label></div>)}
          <button>保存产品</button>
        </form></section>
        <section className="card span-6"><h2>上传图片或成片视频</h2><form action="/api/assets" method="post" encType="multipart/form-data" className="stack">
          <label>关联产品<select name="productId"><option value="">暂不关联</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
          <label>素材文件<input name="file" type="file" accept="image/*,video/*" required /></label>
          <button>上传素材</button><p className="muted">本地开发保存到磁盘；记录原文件、校验和、归属与存储键。第一阶段不生成完整视频。</p>
        </form></section>
        <section className="card span-7"><h2>产品资料与缺失项</h2><div className="list">
          {products.length === 0 && <p className="muted">尚无产品。吕总客户不会自动继承演示产品。</p>}
          {products.map((product) => <article key={product.id} className="list-item stack"><div className="row"><strong>{product.name}</strong><span className="badge">v{product.dataVersion}</span><span className="badge">{product.status}</span></div><p className="muted">型号：{product.modelNumber || "未提供"} · 已关联素材 {product.assetLinks.length}</p><div className="facts">{product.fields.map((field) => <div key={field.id} style={{ display: "contents" }}><b>{field.key}</b><span>{field.value || "未提供"}<br /><small className="muted">来源：{field.source || "未记录"}</small></span><span className={`badge ${field.status === "CONFIRMED" ? "ok" : ""}`}>{field.status}</span></div>)}</div><details><summary>更新并确认字段（会生成产品资料新版本）</summary><form action={`/api/products/${product.id}`} method="post" className="stack"><input name="name" defaultValue={product.name} required /><input name="modelNumber" defaultValue={product.modelNumber || ""} />{["material", "dimensions", "supply_scope"].map((key) => { const field = product.fields.find((entry) => entry.key === key); return <div key={key} className="row"><label>{key}<input name={key} defaultValue={field?.value || ""} /></label><label>来源<input name={`${key}_source`} defaultValue={field?.source || ""} /></label><label style={{ flex: "0 0 100px" }}>已确认<input type="checkbox" name={`${key}_confirmed`} defaultChecked={field?.status === "CONFIRMED"} /></label></div>; })}<button>保存产品资料新版本</button></form></details></article>)}
        </div></section>
        <section className="card span-5"><h2>素材库</h2><div className="list">
          {assets.length === 0 && <p className="muted">尚无素材。</p>}
          {assets.map((asset) => <article key={asset.id} className="list-item"><div className="row"><strong>{asset.originalName}</strong><span className="badge">{asset.kind}</span><span className="badge">{asset.variant}</span></div>{asset.kind === "IMAGE" ? <img className="asset-preview" src={`/api/assets/${asset.id}/file`} alt={asset.originalName} /> : <video className="asset-preview" controls src={`/api/assets/${asset.id}/file`} />}<small className="muted">{asset.productLinks.map((link) => link.product.name).join("、") || "未关联产品"} · {Math.ceil(asset.byteSize / 1024)} KB</small></article>)}
        </div></section>
      </div>
    </OperatorShell>
  );
}
