import { notFound } from "next/navigation";
import { OperatorShell } from "@/components/operator-shell";
import { EmptyState, Notice, PageHeader, SectionHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { formatDateTime } from "@/lib/presentation/status";
import { detectDuplicateAsset, getAssetUsage } from "@/services/asset-library-service";
import { AssetActions } from "../asset-actions";
import styles from "../assets.module.css";

const kindLabels: Record<string, string> = { IMAGE: "图片", VIDEO: "视频", DOCUMENT: "文档" };
const availabilityLabels: Record<string, string> = {
  LOCAL_ONLY: "仅本地可用", PRIVATE_REMOTE: "私有远端", PUBLIC_HTTPS: "公开 HTTPS 候选",
  SIGNED_HTTPS: "签名 HTTPS 候选", UNAVAILABLE: "不可用",
};
const reasonLabels: Record<string, string> = {
  LOCAL_STORAGE: "本地存储无法供外部平台读取", REMOTE_URL_MISSING: "尚无可读取的远端地址",
  READY_CANDIDATE: "本地检查通过，平台尚未验证读取", SIGNED_URL_EXPIRED: "签名地址已过期",
  SIGNED_URL_EXPIRES_TOO_SOON: "签名地址即将过期", SIGNED_URL_EXPIRY_UNKNOWN: "签名地址有效期未知",
  HTTPS_REQUIRED: "外部读取要求 HTTPS", HOST_NOT_PUBLIC: "地址无法由外部平台公开访问",
};

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requirePageContext();
  const { id } = await params;
  let usage;
  try { usage = await getAssetUsage(context, id, { recentOnly: true }); }
  catch (error) { if (error instanceof AppError && error.code === "ASSET_NOT_FOUND") notFound(); throw error; }
  const [products, duplicate, workspace] = await Promise.all([
    db.product.findMany({ where: { clientId: context.clientId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    detectDuplicateAsset(context, usage.asset.checksum, id),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { timezone: true } }),
  ]);
  const asset = usage.asset;
  const canWrite = context.role !== "VIEWER";
  return <OperatorShell context={context}><div className="page">
    <a className="text-link" href="/assets">← 返回素材库</a>
    <div className={styles.header}><PageHeader title={asset.originalName} description="素材的产品关联、标签与内容版本引用。外部读取能力仅为本地判定。" /></div>
    <div className={styles.detailGrid}>
      <div className="stack"><section className="card"><SectionHeader title="素材预览" />
        <div className={styles.detailPreview}>{asset.kind === "IMAGE" ? <img src={`/api/assets/${asset.id}/file`} alt={asset.originalName} /> : asset.kind === "VIDEO" ? <video src={`/api/assets/${asset.id}/file`} controls preload="metadata" /> : <span>文档暂无内嵌预览</span>}</div>
        <p><a className="text-link" href={`/api/assets/${asset.id}/file`} target="_blank" rel="noopener noreferrer">在新窗口打开经过身份验证的本地文件</a></p>
      </section>
      <section className="card"><SectionHeader title="内容使用" description="按内容版本引用计数；与实际发布次数不同。" action={<a className="text-link" href="/content">前往内容中心</a>} />
        <p>{usage.usageCount} 次内容版本引用{usage.platformUsage.length ? ` · ${usage.platformUsage.map((entry) => `${entry.platform} ${entry.count}`).join("、")}` : ""}</p>
        {usage.recentUsage.length ? <ul className={styles.linkList}>{usage.recentUsage.map((entry) => <li key={entry.contentVersionId}>
          <a className="text-link" href={`/content/${entry.contentItemId}`}>内容版本 v{entry.version}</a> · {entry.platform} · {entry.account?.displayName || "未知账号"} · {formatDateTime(entry.usedAt, "—", workspace.timezone)}
        </li>)}</ul> : <EmptyState title="尚无内容使用记录" description="内容版本引用此素材后，会显示在这里。" />}
        {usage.usageCount > usage.recentUsage.length ? <p className="muted">仅展示最近 {usage.recentUsage.length} 条；上方计数覆盖全部有效租户引用。</p> : null}
      </section></div>
      <div className="stack"><section className="card"><SectionHeader title="素材资料" />
        <dl className={styles.pairs}><dt>类型</dt><dd>{kindLabels[asset.kind] || asset.kind}</dd><dt>文件大小</dt><dd>{(asset.byteSize / 1024 / 1024).toFixed(2)} MB</dd>
          <dt>尺寸</dt><dd>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "未知"}</dd><dt>时长</dt><dd>{asset.duration !== null ? `${asset.duration} 秒` : "未知"}</dd>
          <dt>创建时间</dt><dd>{formatDateTime(asset.createdAt, "—", workspace.timezone)}</dd>
          <dt>外部读取分类</dt><dd>{availabilityLabels[asset.availability]}</dd><dt>原因</dt><dd>{reasonLabels[asset.externalRead.reason] || asset.externalRead.message || asset.externalRead.reason}</dd>
          <dt>平台验证</dt><dd>未验证</dd><dt>标签</dt><dd>{asset.tagLinks.length ? asset.tagLinks.map((link) => link.tag.name).join("、") : "无"}</dd>
        </dl>
        {asset.externalRead.expiresAt ? <p className="muted">候选地址有效期至 {formatDateTime(new Date(asset.externalRead.expiresAt), "—", workspace.timezone)}；页面不展示签名地址。</p> : null}
      </section>
      <section className="card"><SectionHeader title="关联产品" />{usage.linkedProducts.length ? <ul className={styles.linkList}>{usage.linkedProducts.map((product) => <li key={product.id}><a className="text-link" href={`/products/${product.id}`}>{product.name}</a></li>)}</ul> : <EmptyState title="未关联产品" description="关联产品后可从产品资料查找此素材。" />}</section>
      {duplicate.duplicate && duplicate.asset ? <Notice title="发现相同 checksum 的另一条素材" tone="warning"><a className="text-link" href={`/assets/${duplicate.asset.id}`}>{duplicate.asset.originalName}</a>。请核对是否需要保留两条记录。</Notice> : null}
      {canWrite ? <section className="card"><SectionHeader title="管理标签与产品" /><AssetActions assetId={asset.id} tags={asset.tagLinks.map((link) => ({ id: link.tag.id, name: link.tag.name }))} products={products} linkedProductIds={usage.linkedProducts.map((product) => product.id)} /></section>
        : <Notice title="只读访问">当前角色只能查看素材及使用记录。</Notice>}
      </div>
    </div>
  </div></OperatorShell>;
}
