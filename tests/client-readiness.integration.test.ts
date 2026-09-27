import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ContentStatus } from "@prisma/client";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import { manualAccountMetadata } from "../src/lib/manual-account";
import { getClientReadiness } from "../src/services/client-readiness-service";

const clientIds: string[] = [];
const userIds: string[] = [];

async function fixture(mode: "LIVE" | "DRAFT" | "DEMO" = "LIVE") {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `readiness-${suffix}`, name: `Readiness ${suffix}`, mode } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `readiness-${suffix}@example.local`, displayName: "Owner", passwordHash: "unused" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const context: RequestContext = { clientId: client.id, userId: user.id, role: "OWNER" };
  return { client, user, context };
}

async function makeContent(
  context: RequestContext,
  productId: string,
  accountId: string,
  status: ContentStatus,
  productDataVersion: number,
) {
  const plan = await db.contentPlan.create({ data: {
    clientId: context.clientId, productId, theme: `Readiness ${randomUUID()}`, objective: "Test current workflow", channels: ["facebook"],
  } });
  const item = await db.contentItem.create({ data: {
    clientId: context.clientId, planId: plan.id, accountId, platform: "facebook", status,
  } });
  const version = await db.contentVersion.create({ data: {
    clientId: context.clientId, contentItemId: item.id, version: 1, text: "Confirmed product information",
    productDataVersion, generator: "test", generationLabel: "test", sourceFacts: {}, source: "AI",
  } });
  await db.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
  return { item, version };
}

afterEach(async () => {
  for (const id of clientIds.splice(0)) await db.client.deleteMany({ where: { id } });
  for (const id of userIds.splice(0)) await db.user.deleteMany({ where: { id } });
});
afterAll(async () => { await db.$disconnect(); });

describe("client readiness projection", () => {
  it("uses the existing confirmed-fact rule for AI while leaving manual creation independent", async () => {
    const { context } = await fixture();
    const product = await db.product.create({ data: { clientId: context.clientId, name: "Unconfirmed product" } });
    await db.productField.create({ data: {
      clientId: context.clientId, productId: product.id, key: "material", value: "steel", status: "PROPOSED",
    } });
    const manual = await db.socialAccount.create({ data: {
      clientId: context.clientId, platform: "linkedin", displayName: "Human LinkedIn",
      metadata: manualAccountMetadata("https://www.linkedin.com/company/example"),
      isSelected: true, publishCapability: "UNSUPPORTED",
    } });
    const view = await getClientReadiness(context);
    expect(view.content.find((value) => value.key === "ai-content")).toMatchObject({ status: "BLOCKED", nextHref: "/products" });
    expect(view.content.find((value) => value.key === "manual-content")).toMatchObject({ status: "READY", nextHref: "/content?manual=1#manual-content" });
    expect(view.foundations.find((value) => value.key === "strategy")).toMatchObject({ status: "BLOCKED", nextHref: "/strategy" });
    expect(view.foundations.find((value) => value.key === "target-markets")).toMatchObject({ status: "ATTENTION" });
    expect(view.followUp.find((value) => value.key === "analytics-review")).toMatchObject({ status: "ATTENTION" });
    expect(view.followUp.find((value) => value.key === "lead-handoff")).toMatchObject({ status: "READY" });
    expect(view.products).toEqual([{ id: product.id, name: product.name, confirmedFactCount: 0, status: "BLOCKED" }]);
    expect(view.accounts.find((value) => value.id === manual.id)).toMatchObject({ mode: "MANUAL", publishing: { status: "READY" }, metrics: { status: "NOT_APPLICABLE" } });
    expect(await db.auditLog.count({ where: { clientId: context.clientId } })).toBe(0);
  });

  it("separates verified Facebook API, limited Instagram API, manual publishing and API data capabilities", async () => {
    const { context, user } = await fixture();
    await db.product.create({ data: { clientId: context.clientId, name: "Confirmed", fields: { create: { clientId: context.clientId, key: "material", value: "steel", status: "CONFIRMED" } } } });
    await db.socialStrategy.create({ data: {
      clientId: context.clientId, createdByUserId: user.id, confirmedByUserId: user.id, confirmedAt: new Date(),
      version: 1, status: "CONFIRMED", payload: {},
    } });
    await db.promptVersion.create({ data: {
      clientId: context.clientId, capability: "multi_platform_content", version: "v1", instruction: "Test", schemaName: "test", modelConfig: {},
    } });
    await db.integrationConfig.create({ data: {
      clientId: context.clientId, type: "TEXT_GENERATION", provider: "openai-compatible", status: "VERIFIED", verifiedAt: new Date(),
    } });
    const connection = await db.platformConnection.create({ data: {
      clientId: context.clientId, provider: "META", status: "CONNECTED", connectedByUserId: user.id,
    } });
    const facebook = await db.socialAccount.create({ data: {
      clientId: context.clientId, platformConnectionId: connection.id, platform: "facebook", displayName: "Verified Facebook",
      externalAccountId: `fb-${randomUUID()}`, isSelected: true,
      accessTokenCiphertext: "test-only", accessTokenIv: "test-only", accessTokenAuthTag: "test-only",
      publishCapability: "VERIFIED", metricsCapability: "VERIFIED", commentsCapability: "VERIFIED",
    } });
    const instagram = await db.socialAccount.create({ data: {
      clientId: context.clientId, platformConnectionId: connection.id, platform: "instagram", displayName: "Unverified Instagram",
      externalAccountId: `ig-${randomUUID()}`, isSelected: true,
      accessTokenCiphertext: "test-only", accessTokenIv: "test-only", accessTokenAuthTag: "test-only",
      publishCapability: "VERIFIED", metricsCapability: "VERIFIED", commentsCapability: "VERIFIED",
    } });
    const wrongProviderConnection = await db.platformConnection.create({ data: {
      clientId: context.clientId, provider: "GOOGLE", status: "CONNECTED", connectedByUserId: user.id,
    } });
    const mismatchedFacebook = await db.socialAccount.create({ data: {
      clientId: context.clientId, platformConnectionId: wrongProviderConnection.id,
      platform: "facebook", displayName: "Wrong provider Facebook",
      externalAccountId: `wrong-fb-${randomUUID()}`, isSelected: true,
      accessTokenCiphertext: "test-only", accessTokenIv: "test-only", accessTokenAuthTag: "test-only",
      publishCapability: "VERIFIED", metricsCapability: "VERIFIED", commentsCapability: "VERIFIED",
    } });
    const manual = await db.socialAccount.create({ data: {
      clientId: context.clientId, platform: "youtube", displayName: "Human YouTube",
      metadata: manualAccountMetadata("https://www.youtube.com/@example"), isSelected: true,
      publishCapability: "UNSUPPORTED", metricsCapability: "UNSUPPORTED", commentsCapability: "UNSUPPORTED",
    } });
    await db.asset.create({ data: {
      clientId: context.clientId, kind: "IMAGE", originalName: "instagram.png", mimeType: "image/png", byteSize: 100,
      storageProvider: "s3", storageKey: "instagram.png", checksum: randomUUID(), metadata: { publicUrl: "https://cdn.example.org/instagram.png" },
    } });
    const keys = ["TEXT_MODEL_BASE_URL", "TEXT_MODEL_API_KEY", "TEXT_MODEL_NAME"] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.TEXT_MODEL_BASE_URL = "https://model.example.test";
      process.env.TEXT_MODEL_API_KEY = "test-only";
      process.env.TEXT_MODEL_NAME = "test-model";
      const view = await getClientReadiness(context);
      expect(view.content.find((value) => value.key === "ai-content")?.status).toBe("READY");
      expect(view.accounts.find((value) => value.id === facebook.id)).toMatchObject({ publishing: { status: "READY" }, metrics: { status: "READY" }, interactions: { status: "READY" } });
      expect(view.accounts.find((value) => value.id === instagram.id)).toMatchObject({ publishing: { status: "ATTENTION" }, media: { status: "ATTENTION" }, metrics: { status: "BLOCKED" }, interactions: { status: "BLOCKED" } });
      expect(view.accounts.find((value) => value.id === instagram.id)?.publishing.detail).toContain("IMPLEMENTED_NOT_EXTERNALLY_VERIFIED");
      expect(view.accounts.find((value) => value.id === instagram.id)?.media.detail).toContain("HTTPS 候选");
      expect(view.accounts.find((value) => value.id === mismatchedFacebook.id)).toMatchObject({
        publishing: { status: "BLOCKED" }, metrics: { status: "ATTENTION" }, interactions: { status: "ATTENTION" },
      });
      expect(view.accounts.find((value) => value.id === manual.id)).toMatchObject({ mode: "MANUAL", publishing: { status: "ATTENTION" }, media: { status: "ATTENTION" }, metrics: { status: "NOT_APPLICABLE" } });
      for (const key of keys) delete process.env[key];
      const missingCredentials = await getClientReadiness(context);
      expect(missingCredentials.content.find((value) => value.key === "ai-content")).toMatchObject({ status: "BLOCKED", nextHref: "/settings" });
      expect(missingCredentials.content.find((value) => value.key === "ai-content")?.detail).toContain("MODEL_CREDENTIALS_MISSING");
    } finally {
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    }
  });

  it("ignores terminal stale content and historical failures, while keeping current stale content and manual UNKNOWN visible", async () => {
    const first = await fixture();
    const second = await fixture();
    const product = await db.product.create({ data: {
      clientId: first.context.clientId, name: "Changed product", dataVersion: 2,
      fields: { create: { clientId: first.context.clientId, key: "material", value: "steel", status: "CONFIRMED" } },
    } });
    const account = await db.socialAccount.create({ data: {
      clientId: first.context.clientId, platform: "facebook", displayName: "Current account", externalAccountId: `fb-${randomUUID()}`,
    } });
    const current = await makeContent(first.context, product.id, account.id, "DRAFT", 1);
    const published = await makeContent(first.context, product.id, account.id, "PUBLISHED", 1);
    await makeContent(first.context, product.id, account.id, "CANCELLED", 1);
    const failed = await makeContent(first.context, product.id, account.id, "FAILED", 1);
    await db.publishJob.create({ data: {
      clientId: first.context.clientId, contentVersionId: failed.version.id, accountId: account.id,
      adapter: "meta-facebook", environment: "LIVE", simulated: false, status: "FAILED", idempotencyKey: randomUUID(),
    } });
    const manualAccount = await db.socialAccount.create({ data: {
      clientId: first.context.clientId, platform: "linkedin", displayName: "Migrated account", metadata: {},
    } });
    await db.publishJob.create({ data: {
      clientId: first.context.clientId, contentVersionId: published.version.id, accountId: manualAccount.id,
      adapter: "manual", environment: "LIVE", simulated: false, status: "UNKNOWN", idempotencyKey: randomUUID(),
    } });
    const otherProduct = await db.product.create({ data: { clientId: second.context.clientId, name: "Other product" } });
    const otherAccount = await db.socialAccount.create({ data: { clientId: second.context.clientId, platform: "facebook", displayName: "Other account" } });
    const otherItem = await makeContent(second.context, otherProduct.id, otherAccount.id, "DRAFT", 1);
    await db.publishJob.create({ data: {
      clientId: second.context.clientId, contentVersionId: otherItem.version.id, accountId: otherAccount.id,
      adapter: "meta-facebook", environment: "LIVE", simulated: false, status: "UNKNOWN", idempotencyKey: randomUUID(),
    } });
    const owner = await getClientReadiness(first.context);
    expect(owner.content.find((value) => value.key === "stale-content")?.detail).toContain("1 条");
    expect(owner.content.find((value) => value.key === "stale-content")?.status).toBe("BLOCKED");
    expect(owner.publishing.find((value) => value.key === "unknown-jobs")?.detail).toContain("1 个");
    expect(owner.accounts.find((value) => value.id === manualAccount.id)).toMatchObject({ mode: "API", unresolvedManualJobs: 1, unresolvedApiJobs: 0 });
    expect(owner.accounts.some((value) => value.id === otherAccount.id)).toBe(false);
    for (const role of ["OPERATOR", "VIEWER"] as const) {
      const view = await getClientReadiness({ ...first.context, role });
      expect(view.content.find((value) => value.key === "stale-content")?.status).toBe("BLOCKED");
      expect(view.accounts.map((value) => value.id)).toEqual(owner.accounts.map((value) => value.id));
    }
    await db.contentItem.update({ where: { id: current.item.id }, data: { status: "CANCELLED" } });
    const resolved = await getClientReadiness(first.context);
    expect(resolved.content.find((value) => value.key === "stale-content")?.status).toBe("READY");
  });

  it("uses only same-tenant relationships for current blockers, REAL metric freshness and open lead handoff", async () => {
    const first = await fixture();
    const second = await fixture();
    const foreignProduct = await db.product.create({ data: { clientId: second.context.clientId, name: "Other tenant product", dataVersion: 2 } });
    const foreignAccount = await db.socialAccount.create({ data: { clientId: second.context.clientId, platform: "facebook", displayName: "Other tenant account" } });
    const foreignContent = await makeContent(second.context, foreignProduct.id, foreignAccount.id, "DRAFT", 1);
    const foreignPlan = await db.contentPlan.create({ data: {
      clientId: second.context.clientId, productId: foreignProduct.id,
      theme: "Foreign plan", objective: "Tenant boundary fixture", channels: ["facebook"],
    } });
    const crossTenantItem = await db.contentItem.create({ data: {
      clientId: first.context.clientId, planId: foreignPlan.id, accountId: foreignAccount.id,
      platform: "facebook", status: "DRAFT",
    } });
    const crossTenantVersion = await db.contentVersion.create({ data: {
      clientId: first.context.clientId, contentItemId: crossTenantItem.id, version: 1,
      text: "cross tenant fixture", productDataVersion: 1, generator: "test", generationLabel: "test", sourceFacts: {},
    } });
    await db.contentItem.update({ where: { id: crossTenantItem.id }, data: { currentVersionId: crossTenantVersion.id } });
    await db.publishJob.create({ data: {
      clientId: first.context.clientId, contentVersionId: foreignContent.version.id, accountId: foreignAccount.id,
      adapter: "manual", environment: "LIVE", simulated: false, status: "UNKNOWN", idempotencyKey: randomUUID(),
    } });
    const now = new Date();
    await db.metricSnapshot.create({ data: {
      clientId: first.context.clientId, accountId: foreignAccount.id, metricKey: "impressions", numericValue: "7",
      availability: "AVAILABLE", dataKind: "REAL", fetchedAt: now, source: "test-foreign",
    } });
    const foreignInteraction = await db.interaction.create({ data: {
      clientId: second.context.clientId, platform: "facebook", platformRecordId: randomUUID(),
      interactionType: "COMMENT", body: "Interested", occurredAt: now,
    } });
    await db.lead.create({ data: {
      clientId: first.context.clientId, interactionId: foreignInteraction.id,
      category: "INQUIRY", priority: "NORMAL", rationale: "Test", handoffStatus: "NEW",
    } });
    const isolated = await getClientReadiness(first.context);
    expect(isolated.content.find((value) => value.key === "stale-content")?.status).toBe("READY");
    expect(isolated.publishing.find((value) => value.key === "unknown-jobs")?.status).toBe("READY");
    expect(isolated.followUp.find((value) => value.key === "analytics-review")?.status).toBe("ATTENTION");
    expect(isolated.followUp.find((value) => value.key === "lead-handoff")?.status).toBe("READY");

    const ownAccount = await db.socialAccount.create({ data: { clientId: first.context.clientId, platform: "facebook", displayName: "Own account" } });
    const realMetric = await db.metricSnapshot.create({ data: {
      clientId: first.context.clientId, accountId: ownAccount.id, metricKey: "reach", numericValue: "11",
      availability: "AVAILABLE", dataKind: "REAL", fetchedAt: now, source: "test-own",
    } });
    const ownInteraction = await db.interaction.create({ data: {
      clientId: first.context.clientId, platform: "facebook", platformRecordId: randomUUID(),
      interactionType: "COMMENT", body: "Request catalog", occurredAt: now,
    } });
    await db.lead.create({ data: {
      clientId: first.context.clientId, interactionId: ownInteraction.id,
      category: "CATALOG_REQUEST", priority: "NORMAL", rationale: "Test", handoffStatus: "WAITING_FEEDBACK",
    } });
    const actionable = await getClientReadiness(first.context);
    expect(actionable.followUp.find((value) => value.key === "analytics-review")?.status).toBe("READY");
    expect(actionable.followUp.find((value) => value.key === "lead-handoff")).toMatchObject({ status: "ATTENTION", nextHref: "/insights#leads" });
    expect(actionable.followUp.find((value) => value.key === "lead-handoff")?.detail).toContain("1 条");
    await db.metricSnapshot.update({ where: { id: realMetric.id }, data: { fetchedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) } });
    expect((await getClientReadiness(first.context)).followUp.find((value) => value.key === "analytics-review")?.status).toBe("ATTENTION");
  });
});
