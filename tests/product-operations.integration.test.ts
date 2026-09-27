import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireContext, requirePageContext } from "../src/lib/auth";
import ProductsPage from "../src/app/products/page";
import ProductDetailPage from "../src/app/products/[id]/page";
import { POST as updateProductRoute } from "../src/app/api/products/[id]/route";
import { getStorageAdapter } from "../src/lib/adapters/storage";
import { MockTextGenerationAdapter } from "../src/lib/adapters/text-generation";
import type { DraftGenerationInput, TextGenerationAdapter } from "../src/lib/adapters/types";
import { db } from "../src/lib/db";
import type { RequestContext } from "../src/lib/context";
import { buildProductContext } from "../src/services/context-builder-service";
import { generateContentPlan } from "../src/services/content-service";
import { createProduct, updateProductFacts, uploadAsset } from "../src/services/product-service";

vi.mock("../src/lib/auth", () => ({ requirePageContext: vi.fn(), requireContext: vi.fn() }));

function pageMarkup(element: ReactElement<{ children: ReactNode }>) {
  // OperatorShell is an async layout; inspect the page content it receives.
  return renderToStaticMarkup(element.props.children);
}

const clients: string[] = [];
const users: string[] = [];
const uploaded: Array<{ provider: string; key: string }> = [];

async function fixture() {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `product-operations-${suffix}`, name: "Product operations", mode: "DEMO", isDemo: true } });
  clients.push(client.id);
  const user = await db.user.create({ data: { email: `product-operations-${suffix}@example.local`, displayName: "Owner", passwordHash: "unused" } });
  users.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  return { client, context: { clientId: client.id, userId: user.id, role: "OWNER" } as RequestContext };
}

afterEach(async () => {
  for (const { provider, key } of uploaded.splice(0)) await getStorageAdapter(provider).delete(key).catch(() => undefined);
  for (const id of clients.splice(0)) await db.client.deleteMany({ where: { id } });
  for (const id of users.splice(0)) await db.user.deleteMany({ where: { id } });
});
afterAll(async () => { await db.$disconnect(); });

describe("Product operations version and asset boundaries", () => {
  it("keeps a foreign ProductField out of product context and the AI generation input", async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const product = await createProduct(owner.context, { name: "Verified chair", fields: [
      { key: "material", value: "owner steel", status: "CONFIRMED", source: "owner catalogue" },
    ] });
    await db.productField.create({ data: { clientId: foreign.client.id, productId: product.id, key: "private_claim", value: "B-PRIVATE-CLAIM", status: "CONFIRMED", source: "B-PRIVATE-SOURCE" } });
    const context = await buildProductContext(owner.context, product.id);
    expect(context.confirmedFacts).toEqual([{ key: "material", value: "owner steel", source: "owner catalogue" }]);
    expect(JSON.stringify(context)).not.toContain("B-PRIVATE");
    const account = await db.socialAccount.create({ data: { clientId: owner.client.id, platform: "facebook", displayName: "Owner page", isSelected: true, publishCapability: "VERIFIED" } });
    await db.promptVersion.create({ data: { clientId: owner.client.id, capability: "multi_platform_content", version: randomUUID(), instruction: "Confirmed facts only", schemaName: "GeneratedDrafts", modelConfig: {} } });
    const mock = new MockTextGenerationAdapter();
    let captured: DraftGenerationInput | null = null;
    const adapter: TextGenerationAdapter = { async generate(input) { captured = input; return mock.generate(input); } };
    const result = await generateContentPlan(owner.context, { productId: product.id, theme: "Wholesale", objective: "Qualified enquiries", accountIds: [account.id], assetIds: [] }, adapter);
    expect(captured!.confirmedFacts).toEqual([{ key: "material", value: "owner steel", source: "owner catalogue" }]);
    expect(JSON.stringify(captured)).not.toContain("B-PRIVATE");
    expect(JSON.stringify(result.items[0].currentVersion.sourceFacts)).not.toContain("B-PRIVATE");
  });

  it("hides a mismatched ProductField tenant from list and detail and rejects writes", async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const product = await createProduct(owner.context, { name: "Scoped chair", fields: [
      { key: "material", value: "owner steel", status: "PROPOSED", source: "owner note" },
    ] });
    await db.productField.create({ data: {
      clientId: foreign.client.id, productId: product.id, key: "supply_scope",
      value: "B-PRIVATE-WHOLESALE-TERMS", status: "CONFIRMED", source: "B-PRIVATE-SOURCE",
    } });
    vi.mocked(requirePageContext).mockResolvedValue(owner.context);
    const list = pageMarkup(await ProductsPage({ searchParams: Promise.resolve({}) }));
    const detail = pageMarkup(await ProductDetailPage({ params: Promise.resolve({ id: product.id }) }));
    for (const html of [list, detail]) {
      expect(html).toContain("Scoped chair");
      expect(html).not.toContain("B-PRIVATE-WHOLESALE-TERMS");
      expect(html).not.toContain("B-PRIVATE-SOURCE");
    }
    expect(list).toContain("已确认 0");
    await expect(updateProductFacts(owner.context, product.id, {
      name: product.name, expectedDataVersion: product.dataVersion,
      fields: [{ key: "material", value: "owner steel", status: "PROPOSED", source: "owner note" }],
    })).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH", status: 409 });
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).dataVersion).toBe(product.dataVersion);
    expect(await db.auditLog.count({ where: { clientId: owner.client.id, action: "PRODUCT_FACTS_UPDATED" } })).toBe(0);
  });

  it("keeps no-op saves unchanged, preserves custom confirmed facts, and rejects stale editors", async () => {
    const f = await fixture();
    const product = await createProduct(f.context, {
      name: "Chair", modelNumber: "C-1",
      fields: [{ key: "certification", value: "EN 12520", status: "CONFIRMED", source: "customer specification" }, { key: "material", value: "steel", status: "PROPOSED", source: "operator note" }],
    });
    const beforeAudit = await db.auditLog.count({ where: { clientId: f.client.id, action: "PRODUCT_FACTS_UPDATED" } });
    const unchanged = await updateProductFacts(f.context, product.id, { name: "Chair", modelNumber: "C-1", expectedDataVersion: 1, fields: [{ key: "material", value: "steel", status: "PROPOSED", source: "operator note" }] });
    expect(unchanged.dataVersion).toBe(1);
    expect(await db.auditLog.count({ where: { clientId: f.client.id, action: "PRODUCT_FACTS_UPDATED" } })).toBe(beforeAudit);
    const input = (value: string) => ({ name: "Chair", modelNumber: "C-1", expectedDataVersion: 1, fields: [{ key: "material", value, status: "PROPOSED", source: "operator note" }] });
    const results = await Promise.allSettled([updateProductFacts(f.context, product.id, input("aluminum")), updateProductFacts(f.context, product.id, input("timber"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual(["PRODUCT_VERSION_CONFLICT"]);
    const latest = await db.product.findUniqueOrThrow({ where: { id: product.id }, include: { fields: true } });
    expect(latest.dataVersion).toBe(2);
    expect(latest.status).toBe("CONFIRMED");
    expect(latest.fields.find((field) => field.key === "certification")).toMatchObject({ value: "EN 12520", status: "CONFIRMED" });
    await expect(updateProductFacts({ ...f.context, role: "VIEWER" }, product.id, { ...input("unsafe"), expectedDataVersion: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await fixture();
    await expect(updateProductFacts(other.context, product.id, { ...input("unsafe"), expectedDataVersion: 2 })).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("serializes same-client checksum upload and keeps only one asset", async () => {
    const f = await fixture();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024, 3)]);
    const file = () => new File([png], "chair.png", { type: "image/png" });
    const results = await Promise.allSettled([uploadAsset(f.context, { file: file() }), uploadAsset(f.context, { file: file() })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual(["DUPLICATE_ASSET"]);
    const asset = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof uploadAsset>>>).value;
    uploaded.push({ provider: asset.storageProvider, key: asset.storageKey });
    expect(await db.asset.count({ where: { clientId: f.client.id, checksum: asset.checksum } })).toBe(1);
    const other = await fixture();
    const sameBytesOtherTenant = await uploadAsset(other.context, { file: file() });
    uploaded.push({ provider: sameBytesOtherTenant.storageProvider, key: sameBytesOtherTenant.storageKey });
    expect(sameBytesOtherTenant.id).not.toBe(asset.id);
  });

  it("returns a clear 400 for missing or invalid expected product versions", async () => {
    const f = await fixture();
    const product = await createProduct(f.context, { name: "Chair", fields: [] });
    for (const expectedDataVersion of [undefined, null, "", "abc", 0, 1.5, true]) {
      await expect(updateProductFacts(f.context, product.id, { name: product.name, fields: [], expectedDataVersion }))
        .rejects.toMatchObject({ code: "INVALID_EXPECTED_DATA_VERSION", status: 400 });
    }
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).dataVersion).toBe(1);
  });

  it("shows an actionable HTML conflict while preserving the JSON API contract", async () => {
    const f = await fixture();
    const product = await createProduct(f.context, { name: "Chair", fields: [] });
    await updateProductFacts(f.context, product.id, { name: "Updated chair", fields: [], expectedDataVersion: 1 });
    vi.mocked(requireContext).mockResolvedValue(f.context);
    const body = JSON.stringify({ name: "Stale chair", fields: [], expectedDataVersion: 1 });
    const path = `http://localhost/api/products/${product.id}`;
    const html = await updateProductRoute(new Request(path, { method: "POST", headers: { "content-type": "application/json", accept: "text/html" }, body }), { params: Promise.resolve({ id: product.id }) });
    expect(html.status).toBe(409);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain(`/products/${product.id}`);
    const json = await updateProductRoute(new Request(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body }), { params: Promise.resolve({ id: product.id }) });
    expect(json.status).toBe(409);
    expect(await json.json()).toMatchObject({ error: "PRODUCT_VERSION_CONFLICT" });
  });

  it("retains storage when a committed upload loses its transaction response", async () => {
    const f = await fixture();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024, 8)]);
    const original = db.$transaction.bind(db);
    const transaction = vi.spyOn(db, "$transaction").mockImplementation((async (callback: unknown) => {
      await original(callback as Parameters<typeof original>[0]);
      throw new Error("SIMULATED_POST_COMMIT_RESPONSE_LOSS");
    }) as typeof db.$transaction);
    try {
      await expect(uploadAsset(f.context, { file: new File([png], "response-lost.png", { type: "image/png" }) }))
        .rejects.toThrow("SIMULATED_POST_COMMIT_RESPONSE_LOSS");
    } finally {
      transaction.mockRestore();
    }
    const asset = await db.asset.findFirstOrThrow({ where: { clientId: f.client.id, originalName: "response-lost.png" } });
    uploaded.push({ provider: asset.storageProvider, key: asset.storageKey });
    expect((await getStorageAdapter(asset.storageProvider).metadata(asset.storageKey)).contentLength).toBe(png.length);
  });
});
