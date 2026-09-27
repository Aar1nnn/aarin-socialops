import { OperatorShell } from "@/components/operator-shell";
import { Button, EmptyState, FormField, Notice, PageHeader, SectionHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { listAssetLibraryPage } from "@/services/asset-library-service";
import styles from "./assets.module.css";

type Params = Record<string, string | string[] | undefined>;
const kindOptions = ["IMAGE", "VIDEO", "DOCUMENT"] as const;
const availabilityOptions = ["LOCAL_ONLY", "PRIVATE_REMOTE", "PUBLIC_HTTPS", "SIGNED_HTTPS", "UNAVAILABLE"] as const;
const availabilityLabels: Record<string, string> = {
  LOCAL_ONLY: "仅本地可用", PRIVATE_REMOTE: "私有远端", PUBLIC_HTTPS: "公开 HTTPS 候选",
  SIGNED_HTTPS: "签名 HTTPS 候选", UNAVAILABLE: "不可用",
};
const kindLabels: Record<string, string> = { IMAGE: "图片", VIDEO: "视频", DOCUMENT: "文档" };

function one(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }

export default async function AssetsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const context = await requirePageContext();
  const params = await searchParams;
  const query = one(params.query)?.trim() || "";
  const kind = one(params.kind) || "";
  const productId = one(params.productId) || "";
  const tagId = one(params.tagIds) || "";
  const availability = one(params.availability) || "";
  const cursor = one(params.cursor) || undefined;
  const filter = {
    query: query || undefined,
    kind: kindOptions.includes(kind as typeof kindOptions[number]) ? kind : undefined,
    productId: productId || undefined,
    tagIds: tagId ? [tagId] : undefined,
    availability: availabilityOptions.includes(availability as typeof availabilityOptions[number]) ? availability : undefined,
    limit: 24,
    cursor,
  };
  let staleCursor = false;
  const [page, products, tags] = await Promise.all([
    listAssetLibraryPage(context, filter).catch((error: unknown) => {
      if (error instanceof AppError && error.code === "ASSET_CURSOR_INVALID") {
        staleCursor = true;
        return listAssetLibraryPage(context, { ...filter, cursor: undefined });
      }
      throw error;
    }),
    db.product.findMany({ where: { clientId: context.clientId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.assetTag.findMany({ where: { clientId: context.clientId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const canWrite = context.role !== "VIEWER";
  const nextParams = new URLSearchParams();
  if (query) nextParams.set("query", query);
  if (kind) nextParams.set("kind", kind);
  if (productId) nextParams.set("productId", productId);
  if (tagId) nextParams.set("tagIds", tagId);
  if (availability) nextParams.set("availability", availability);
  if (page.nextCursor) nextParams.set("cursor", page.nextCursor);
  const hasFilters = Boolean(query || kind || productId || tagId || availability);

  return <OperatorShell context={context}><div className="page">
    <PageHeader title="素材库" description="查找、核对并复用图片、视频和文档；使用记录来自实际产品和内容版本关联。" action={canWrite ? <a className="button button-primary button-md" href="#upload-asset">上传素材</a> : undefined} />
    {staleCursor ? <Notice title="分页位置已失效" tone="warning">已从当前筛选条件的第一页重新显示素材。</Notice> : null}
    {canWrite ? <details className="disclosure" id="upload-asset"><summary>上传新素材</summary><div className="disclosure-body">
      <form action="/api/assets" method="post" encType="multipart/form-data" className="form-stack">
        <input type="hidden" name="returnTo" value="/assets" />
        <div className="form-grid"><FormField label="素材文件" htmlFor="library-file" helper="支持现有上传服务认可的图片和视频格式。"><input id="library-file" type="file" name="file" accept="image/*,video/*" required /></FormField>
          <FormField label="关联产品（可选）" htmlFor="library-product"><select id="library-product" name="productId" defaultValue={productId}><option value="">暂不关联</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></FormField></div>
        <div className="actions"><Button type="submit">上传素材</Button></div>
      </form>
    </div></details> : <Notice title="只读访问">当前角色可以检索素材和查看使用记录；上传与关联需要所有者或运营者权限。</Notice>}
    <section className="card"><SectionHeader title="查找素材" description="可按产品、标签和实时计算的外部读取分类组合筛选。" />
      <form method="get" action="/assets" className={styles.filters}>
        <FormField label="文件名" htmlFor="asset-query"><input id="asset-query" name="query" defaultValue={query} maxLength={200} placeholder="搜索文件名" /></FormField>
        <FormField label="类型" htmlFor="asset-kind"><select id="asset-kind" name="kind" defaultValue={kind}><option value="">全部类型</option>{kindOptions.map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}</select></FormField>
        <FormField label="产品" htmlFor="asset-product-filter"><select id="asset-product-filter" name="productId" defaultValue={productId}><option value="">全部产品</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></FormField>
        <FormField label="标签" htmlFor="asset-tag-filter"><select id="asset-tag-filter" name="tagIds" defaultValue={tagId}><option value="">全部标签</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></FormField>
        <FormField label="外部读取分类" htmlFor="asset-availability"><select id="asset-availability" name="availability" defaultValue={availability}><option value="">全部分类</option>{availabilityOptions.map((value) => <option key={value} value={value}>{availabilityLabels[value]}</option>)}</select></FormField>
        <div className="actions"><Button type="submit">筛选</Button>{hasFilters ? <a className="button button-secondary button-md" href="/assets">清除</a> : null}</div>
      </form>
    </section>
    <section className="section"><SectionHeader title="素材" description="外部读取状态是本地判定候选，尚未由任何平台验证获取。" />
      {page.items.length ? <div className={styles.tiles}>{page.items.map((asset) => <a key={asset.id} className={styles.tile} href={`/assets/${asset.id}`}>
        <div className={styles.preview}>{asset.kind === "IMAGE" ? <img src={`/api/assets/${asset.id}/file`} alt="" loading="lazy" /> : <span>{kindLabels[asset.kind] || asset.kind}</span>}</div>
        <div className={styles.tileBody}><strong>{asset.originalName}</strong><div className={styles.tileMeta}><span>{kindLabels[asset.kind] || asset.kind}</span><span>{availabilityLabels[asset.availability]}</span><span>{asset._count.contentLinks} 次版本引用</span></div>
          <div className={styles.tileMeta}>{asset.productLinks.length ? asset.productLinks.map((link) => link.product.name).join("、") : "未关联产品"}</div>
          {asset.tagLinks.length ? <div className={styles.tileMeta}>标签：{asset.tagLinks.map((link) => link.tag.name).join("、")}</div> : null}
        </div>
      </a>)}</div> : <EmptyState title={page.nextCursor ? "当前扫描批次没有匹配素材" : hasFilters ? "没有匹配的素材" : "素材库尚为空"} description={page.nextCursor ? "可继续扫描后续素材；分类在读取时计算。" : hasFilters ? "调整筛选条件，或清除筛选查看全部素材。" : "上传第一个素材后即可查看分类、关联和使用记录。"} />}
      <div className={styles.pager}><span className="muted">本批次显示 {page.items.length} 条；扫描 {page.scanned} 条素材。</span>{page.nextCursor ? <a className="button button-secondary button-md" href={`/assets?${nextParams.toString()}`}>下一页</a> : null}</div>
    </section>
  </div></OperatorShell>;
}
