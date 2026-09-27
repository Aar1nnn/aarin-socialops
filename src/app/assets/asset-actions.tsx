"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, FormField } from "@/components/ui";

type Tag = { id: string; name: string };
type Product = { id: string; name: string };

export function AssetActions({ assetId, tags, products, linkedProductIds }: {
  assetId: string;
  tags: Tag[];
  products: Product[];
  linkedProductIds: string[];
}) {
  const router = useRouter();
  const [tagText, setTagText] = useState(tags.map((tag) => tag.name).join(", "));
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setTagText(tags.map((tag) => tag.name).join(", ")), [tags]);

  async function submit(event: FormEvent<HTMLFormElement>, path: "tags" | "products", body: Record<string, unknown>) {
    event.preventDefault();
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch(`/api/assets/${assetId}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? `${result.message || "资料已变化"} 请刷新页面后重试。` : result.message || "操作失败，请重试。");
      setMessage(path === "tags" ? "标签已保存。" : result.linked ? "已关联产品。" : "该产品已关联。");
      if (path === "products") setProductId("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally { setBusy(false); }
  }

  const availableProducts = products.filter((product) => !linkedProductIds.includes(product.id));
  return <div className="stack">
    <form className="form-stack" onSubmit={(event) => submit(event, "tags", {
      tags: tagText.split(/[,，\n]/).map((name) => name.trim()).filter(Boolean),
      expectedTagIds: tags.map((tag) => tag.id),
    })}>
      <FormField label="素材标签" htmlFor="asset-tag-editor" helper="用逗号分隔；标签保存前会核对你打开页面时看到的标签集合。">
        <input id="asset-tag-editor" value={tagText} onChange={(event) => setTagText(event.target.value)} maxLength={5000} />
      </FormField>
      <div className="actions"><Button type="submit" disabled={busy}>保存标签</Button></div>
    </form>
    <form className="form-stack" onSubmit={(event) => submit(event, "products", { productId })}>
      <FormField label="关联现有产品" htmlFor="asset-product-editor" helper="只增加关联；已有内容版本的素材使用记录保持原样。">
        <select id="asset-product-editor" value={productId} onChange={(event) => setProductId(event.target.value)} required disabled={!availableProducts.length}>
          <option value="">选择产品</option>{availableProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
      </FormField>
      <div className="actions"><Button type="submit" variant="secondary" disabled={busy || !productId}>关联产品</Button></div>
      {!availableProducts.length ? <p className="muted">没有其他可关联产品。可先到产品资料添加产品。</p> : null}
    </form>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert" className="muted">{error}</p> : null}
  </div>;
}
