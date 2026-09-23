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
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/presentation/status";

const factFields = [
  { key: "material", label: "材质" },
  { key: "dimensions", label: "尺寸" },
  { key: "supply_scope", label: "供货范围" },
] as const;

const factLabels = Object.fromEntries(factFields.map((field) => [field.key, field.label])) as Record<string, string>;

const assetKindLabels: Record<string, string> = {
  IMAGE: "图片",
  VIDEO: "视频",
  DOCUMENT: "文档",
};

const assetVariantLabels: Record<string, string> = {
  ORIGINAL: "原始素材",
  DERIVED: "衍生素材",
};

function factLabel(key: string) {
  return factLabels[key] ?? key;
}

function productFactState(fields: Array<{ status: string }>) {
  if (fields.length === 0) return { value: null, label: "尚无事实字段" };
  const missing = fields.filter((field) => field.status === "MISSING").length;
  const proposed = fields.filter((field) => field.status === "PROPOSED").length;
  if (missing > 0) return { value: "MISSING", label: `${missing} 项缺失` };
  if (proposed > 0) return { value: "PROPOSED", label: `${proposed} 项待确认` };
  return { value: "CONFIRMED", label: "事实已确认" };
}

function formatFileSize(byteSize: number) {
  if (byteSize >= 1024 * 1024) return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(byteSize / 1024))} KB`;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ create?: string | string[] }>;
}) {
  const context = await requirePageContext();
  const params = await searchParams;
  const createRequested = (Array.isArray(params.create) ? params.create[0] : params.create) === "1";
  const [products, assets, workspace] = await Promise.all([
    db.product.findMany({
      where: { clientId: context.clientId },
      include: {
        fields: true,
        assetLinks: { include: { asset: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    db.asset.findMany({
      where: { clientId: context.clientId },
      include: { productLinks: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
    }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  const canWrite = context.role === "OWNER" || context.role === "OPERATOR";

  return (
    <OperatorShell context={context}>
      <div className="page">
        <PageHeader
          title="产品"
          description="产品资料与素材是内容生成的事实来源。"
          action={canWrite ? (
            <a
              className="button button-primary button-md"
              href="/products?create=1#create-product"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              添加产品
            </a>
          ) : undefined}
        />

        {canWrite ? (
          <div className="grid">
            <details className="disclosure span-6" id="create-product" open={products.length === 0 || createRequested}>
              <summary>添加产品</summary>
              <div className="disclosure-body">
                <form action="/api/products" method="post" className="form-stack">
                  <div className="form-grid">
                    <FormField label="产品名称" htmlFor="new-product-name">
                      <input id="new-product-name" name="name" required />
                    </FormField>
                    <FormField label="型号" htmlFor="new-product-model">
                      <input id="new-product-model" name="modelNumber" />
                    </FormField>
                  </div>

                  {factFields.map(({ key, label }) => (
                    <div className="form-grid" key={key}>
                      <FormField label={label} htmlFor={`new-${key}`}>
                        <input id={`new-${key}`} name={key} />
                      </FormField>
                      <FormField
                        label="来源"
                        htmlFor={`new-${key}-source`}
                        helper="确认事实时必须记录客户文件或人工确认来源。"
                      >
                        <input id={`new-${key}-source`} name={`${key}_source`} placeholder="客户表格、文件名或人工确认" />
                      </FormField>
                      <div className="form-field">
                        <span>确认状态</span>
                        <label className="row" htmlFor={`new-${key}-confirmed`}>
                          <input
                            id={`new-${key}-confirmed`}
                            type="checkbox"
                            name={`${key}_confirmed`}
                            value="on"
                            style={{ width: "auto", minHeight: 0 }}
                          />
                          已核对
                        </label>
                      </div>
                    </div>
                  ))}

                  <div className="actions">
                    <Button type="submit">保存产品</Button>
                  </div>
                </form>
              </div>
            </details>

            <details className="disclosure span-6" id="upload-asset">
              <summary>上传素材</summary>
              <div className="disclosure-body">
                <form action="/api/assets" method="post" encType="multipart/form-data" className="form-stack">
                  <FormField label="关联产品" htmlFor="asset-product">
                    <select id="asset-product" name="productId" defaultValue="">
                      <option value="">暂不关联</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>{product.name}</option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    label="素材文件"
                    htmlFor="asset-file"
                    helper="支持 PNG、JPEG、WebP、MP4 和 QuickTime 文件。"
                  >
                    <input id="asset-file" name="file" type="file" accept="image/*,video/*" required />
                  </FormField>
                  <div className="actions">
                    <Button type="submit">上传素材</Button>
                  </div>
                </form>
              </div>
            </details>
          </div>
        ) : (
          <Notice title="只读访问">当前角色可查看产品与素材。添加、编辑或上传需要所有者或运营者权限。</Notice>
        )}

        <section className="section">
          <SectionHeader
            title="产品资料"
            description="已确认事实会用于内容生成；待确认和缺失项不会被当作事实。"
          />

          {products.length === 0 ? (
            <EmptyState
              title="还没有产品"
              description="添加第一个产品后，可继续补充事实来源并关联素材。"
            />
          ) : (
            <div className="stack">
              {products.map((product) => {
                const factState = productFactState(product.fields);
                const orderedFields = [...product.fields].sort((left, right) => {
                  const leftIndex = factFields.findIndex((field) => field.key === left.key);
                  const rightIndex = factFields.findIndex((field) => field.key === right.key);
                  return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
                    - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
                });

                return (
                  <details className="disclosure" key={product.id}>
                    <summary>
                      <span>
                        <span className="cell-title">{product.name}</span>
                        <span className="cell-meta">
                          {product.modelNumber || "未填写型号"} · v{product.dataVersion} · {product.assetLinks.length} 个素材 · 更新于 {formatDateTime(product.updatedAt, "—", workspace.timezone)}
                        </span>
                      </span>
                      <StatusIndicator value={factState.value} label={factState.label} compact />
                    </summary>

                    <div className="disclosure-body detail-sections">
                      <section className="detail-section">
                        <div>
                          <h3>产品事实</h3>
                          <p className="muted">每条已确认事实都需要可追溯的来源。</p>
                        </div>
                        {orderedFields.length === 0 ? (
                          <EmptyState title="尚无事实字段" description="编辑产品资料以补充材质、尺寸和供货范围。" />
                        ) : (
                          <div className="table-scroll" role="region" aria-label={`${product.name} 产品事实`} tabIndex={0}>
                            <table>
                              <thead>
                                <tr>
                                  <th scope="col">字段</th>
                                  <th scope="col">值</th>
                                  <th scope="col">来源</th>
                                  <th scope="col">状态</th>
                                </tr>
                              </thead>
                              <tbody>
                                {orderedFields.map((field) => (
                                  <tr key={field.id}>
                                    <td><span className="cell-title">{factLabel(field.key)}</span></td>
                                    <td>{field.value || "未提供"}</td>
                                    <td>{field.source || "未记录"}</td>
                                    <td><StatusIndicator value={field.status} compact /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </section>

                      <section className="detail-section">
                        <div>
                          <h3>关联素材</h3>
                          <p className="muted">直接检查用于该产品内容制作的图片、视频和文档。</p>
                        </div>
                        {product.assetLinks.length === 0 ? (
                          <EmptyState title="尚未关联素材" description="上传素材时选择该产品，即可在这里集中查看。" />
                        ) : (
                          <ul className="asset-list">
                            {product.assetLinks.map(({ asset }) => (
                              <li key={asset.id}>
                                <span>
                                  <a className="text-link" href={`/api/assets/${asset.id}/file`} target="_blank" rel="noreferrer">
                                    {asset.originalName}
                                  </a>
                                  <span className="cell-meta">
                                    {assetKindLabels[asset.kind] ?? "其他素材"} · {assetVariantLabels[asset.variant] ?? "素材"}
                                  </span>
                                </span>
                                <span className="number muted">{formatFileSize(asset.byteSize)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                      {canWrite ? (
                        <section className="detail-section">
                          <details className="disclosure">
                            <summary>编辑产品资料</summary>
                            <div className="disclosure-body">
                              <form action={`/api/products/${product.id}`} method="post" className="form-stack">
                                <Notice title="保存后将创建新版本" tone="warning">
                                  产品资料将从 v{product.dataVersion} 升级。未发布的关联内容将需要重新审核，待发布任务可能被取消。
                                </Notice>
                                <div className="form-grid">
                                  <FormField label="产品名称" htmlFor={`product-${product.id}-name`}>
                                    <input id={`product-${product.id}-name`} name="name" defaultValue={product.name} required />
                                  </FormField>
                                  <FormField label="型号" htmlFor={`product-${product.id}-model`}>
                                    <input id={`product-${product.id}-model`} name="modelNumber" defaultValue={product.modelNumber || ""} />
                                  </FormField>
                                </div>

                                {factFields.map(({ key, label }) => {
                                  const field = product.fields.find((entry) => entry.key === key);
                                  return (
                                    <div className="form-grid" key={key}>
                                      <FormField label={label} htmlFor={`product-${product.id}-${key}`}>
                                        <input id={`product-${product.id}-${key}`} name={key} defaultValue={field?.value || ""} />
                                      </FormField>
                                      <FormField
                                        label="来源"
                                        htmlFor={`product-${product.id}-${key}-source`}
                                        helper="确认事实时必须填写来源。"
                                      >
                                        <input
                                          id={`product-${product.id}-${key}-source`}
                                          name={`${key}_source`}
                                          defaultValue={field?.source || ""}
                                        />
                                      </FormField>
                                      <div className="form-field">
                                        <span>确认状态</span>
                                        <label className="row" htmlFor={`product-${product.id}-${key}-confirmed`}>
                                          <input
                                            id={`product-${product.id}-${key}-confirmed`}
                                            type="checkbox"
                                            name={`${key}_confirmed`}
                                            value="on"
                                            defaultChecked={field?.status === "CONFIRMED"}
                                            style={{ width: "auto", minHeight: 0 }}
                                          />
                                          已核对
                                        </label>
                                      </div>
                                    </div>
                                  );
                                })}
                                <div className="actions">
                                  <Button type="submit">保存产品资料新版本</Button>
                                </div>
                              </form>
                            </div>
                          </details>
                        </section>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>

        <section className="section">
          <SectionHeader
            title="素材库"
            description="查看已上传的图片和成片视频，以及它们关联的产品。"
          />
          {assets.length === 0 ? (
            <EmptyState title="还没有素材" description="上传产品图片或已剪辑视频后，素材将显示在这里。" />
          ) : (
            <div className="asset-grid">
              {assets.map((asset) => (
                <article className="asset-tile" key={asset.id}>
                  {asset.kind === "IMAGE" ? (
                    <img
                      className="asset-preview"
                      src={`/api/assets/${asset.id}/file`}
                      alt={asset.originalName}
                      loading="lazy"
                    />
                  ) : asset.kind === "VIDEO" ? (
                    <video
                      className="asset-preview"
                      controls
                      preload="metadata"
                      src={`/api/assets/${asset.id}/file`}
                      aria-label={asset.originalName}
                    />
                  ) : (
                    <div className="preview">此素材不支持在线预览</div>
                  )}
                  <div className="asset-meta">
                    <strong title={asset.originalName}>{asset.originalName}</strong>
                    <span>
                      {assetKindLabels[asset.kind] ?? "其他素材"} · {assetVariantLabels[asset.variant] ?? "素材"} · {formatFileSize(asset.byteSize)}
                    </span>
                    <span>{asset.productLinks.map((link) => link.product.name).join("、") || "未关联产品"}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </OperatorShell>
  );
}
