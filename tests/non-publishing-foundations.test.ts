import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client, SocialAccount } from "@prisma/client";
import { db } from "../src/lib/db";
import type { RequestContext } from "../src/lib/context";
import type { DraftGenerationInput, TextGenerationAdapter } from "../src/lib/adapters/types";
import { getBrandProfile, upsertBrandProfile } from "../src/services/brand-service";
import { buildContentEngineMemory } from "../src/services/memory-service";
import { runAIContentPipeline } from "../src/services/ai-content-pipeline-service";
import { listCalendarEntries, rescheduleCalendarItems } from "../src/services/calendar-service";
import { aggregateMetricSnapshots, canonicalizeMetricKey, markAnalyticsSyncFailed, markAnalyticsSyncStarted, markAnalyticsSyncSucceeded, periodBounds, resolveFreshness } from "../src/services/analytics-service";
import { createAndDispatchNotification, upsertNotificationRule } from "../src/services/notification-service";

type Fixture = { client: Client; context: RequestContext; account: SocialAccount; promptId: string };
const clientIds: string[] = [];
const userIds: string[] = [];
let fixture: Fixture;

async function makeFixture(brandGuidelines: string | null = "Legacy: direct and factual") {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `foundation-${suffix}`, name: `Foundation ${suffix}`, brandGuidelines } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `foundation-${suffix}@example.local`, displayName: "Foundation", passwordHash: "unused" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "Foundation Page" } });
  const prompt = await db.promptVersion.create({ data: { clientId: client.id, capability: "multi_platform_content", version: `foundation-${suffix}`, instruction: "Use confirmed facts only.", schemaName: "GeneratedDrafts", modelConfig: {} } });
  return { client, account, promptId: prompt.id, context: { clientId: client.id, userId: user.id, role: "OWNER" as const } };
}

async function createContent(input: { status?: "DRAFT" | "APPROVED" | "PUBLISHED"; scheduledAt?: Date; text?: string } = {}) {
  const product = await db.product.create({ data: { clientId: fixture.client.id, name: "Confirmed chair", status: "CONFIRMED" } });
  const plan = await db.contentPlan.create({ data: { clientId: fixture.client.id, productId: product.id, theme: "Wholesale chair", objective: "Qualified enquiry", channels: ["facebook"] } });
  const item = await db.contentItem.create({ data: { clientId: fixture.client.id, planId: plan.id, accountId: fixture.account.id, platform: "facebook", status: input.status || "DRAFT", scheduledAt: input.scheduledAt } });
  const version = await db.contentVersion.create({ data: { clientId: fixture.client.id, contentItemId: item.id, version: 1, title: "Steel chair", text: input.text || "A durable steel chair. Request the verified wholesale catalogue.", productDataVersion: 1, promptVersionId: fixture.promptId, generator: "test", generationLabel: "test", sourceFacts: { confirmedFacts: [{ key: "material", value: "steel", source: "sheet" }] } } });
  await db.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
  return { item, version };
}

beforeEach(async () => { fixture = await makeFixture(); });
afterEach(async () => {
  delete process.env.TEST_WEBHOOK_ENDPOINT;
  delete process.env.TEST_EMAIL_ENDPOINT;
  for (const clientId of clientIds.splice(0)) await db.client.deleteMany({ where: { id: clientId } });
  for (const userId of userIds.splice(0)) await db.user.deleteMany({ where: { id: userId } });
});
afterAll(async () => { await db.$disconnect(); });

describe("brand and memory foundation", () => {
  it("reads the legacy brand fallback and supports structured create/update", async () => {
    expect((await getBrandProfile(fixture.context)).source).toBe("LEGACY_FALLBACK");
    expect((await getBrandProfile(fixture.context)).effectiveTone).toContain("Legacy");
    await upsertBrandProfile(fixture.context, { tone: "Confident", audience: "Wholesale distributors", voiceTraits: ["clear"], goals: ["qualified leads"], contentLanguages: ["en"], bannedPhrases: [], requiredMentions: [], ctaRules: [] });
    const profile = await getBrandProfile(fixture.context);
    expect(profile.source).toBe("STRUCTURED");
    expect(profile.tone).toBe("Confident");
    await upsertBrandProfile(fixture.context, { tone: "Practical", voiceTraits: [], goals: [], contentLanguages: [], bannedPhrases: [], requiredMentions: [], ctaRules: [] });
    expect((await getBrandProfile(fixture.context)).tone).toBe("Practical");
  });

  it("keeps brand and all memory queries tenant scoped", async () => {
    await upsertBrandProfile(fixture.context, { tone: "Tenant A secret tone", voiceTraits: [], goals: [], contentLanguages: [], bannedPhrases: [], requiredMentions: [], ctaRules: [] });
    await createContent({ text: "Tenant A private recent hook. Contact us." });
    await db.metricSnapshot.create({ data: { clientId: fixture.client.id, accountId: fixture.account.id, metricKey: "impressions", numericValue: 11, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "test" } });
    await db.researchRecord.create({ data: { clientId: fixture.client.id, kind: "MARKET", objective: "Tenant A private research", observedAt: new Date(), observations: [], inferences: [], experiments: [], limitations: [] } });
    const other = await makeFixture(null);
    const memory = await buildContentEngineMemory(other.context);
    expect(memory.brand.tone).not.toBe("Tenant A secret tone");
    expect(JSON.stringify(memory)).not.toContain("Tenant A private");
    expect(memory.performance).toHaveLength(0);
    expect(memory.research).toHaveLength(0);
  });

  it("extracts recent content, performance and research without turning missing metrics into zero", async () => {
    await createContent({ text: "Recent hook. Ask for verified MOQ." });
    await db.metricSnapshot.createMany({ data: [
      { clientId: fixture.client.id, accountId: fixture.account.id, metricKey: "impressions", numericValue: 0, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "test" },
      { clientId: fixture.client.id, accountId: fixture.account.id, metricKey: "reach", numericValue: null, availability: "READ_FAILED", dataKind: "REAL", fetchedAt: new Date(), source: "test" },
    ] });
    await db.researchRecord.create({ data: { clientId: fixture.client.id, kind: "MARKET", objective: "Check buyer questions", observedAt: new Date(), observations: [{ fact: "MOQ questions", evidence: "comments" }], inferences: [], experiments: [], limitations: ["small sample"] } });
    const memory = await buildContentEngineMemory(fixture.context);
    expect(memory.recentContent[0].hook).toBe("Recent hook.");
    expect(memory.performance.find((item) => item.metricKey === "impressions")?.value).toBe("0");
    expect(memory.performance.find((item) => item.metricKey === "reach")?.value).toBeNull();
    expect(memory.research[0].objective).toBe("Check buyer questions");
  });
});

describe("AI content pipeline foundation", () => {
  it("passes confirmed facts and memory through validated stages but never creates approval or publish jobs", async () => {
    await upsertBrandProfile(fixture.context, { tone: "Clear", audience: "Distributors", voiceTraits: ["precise"], goals: [], contentLanguages: ["en"], bannedPhrases: ["guaranteed"], requiredMentions: ["wholesale"], ctaRules: ["ask for catalogue"] });
    const captured: DraftGenerationInput[] = [];
    const adapter: TextGenerationAdapter = { async generate(input) { captured.push(input); return { provider: "test", model: "test", simulated: true, usage: { inputUnits: 1, outputUnits: 1 }, output: { drafts: [{ platform: "facebook", title: "Test", text: "Wholesale steel chair. Ask for the catalogue.", usedFactKeys: ["material"], missingInformation: ["dimensions"], isGenericMarketDraft: false }] } }; } };
    const result = await runAIContentPipeline(fixture.context, { clientName: fixture.client.name, mode: fixture.client.mode, targetMarkets: ["US"], productFocus: null, brandGuidelines: fixture.client.brandGuidelines, productName: "Chair", objective: "Leads", theme: "Wholesale", confirmedFacts: [{ key: "material", value: "steel", source: "sheet" }], missingFields: ["dimensions"], platforms: ["facebook"], instruction: "Use confirmed facts only" }, adapter);
    expect(captured[0].confirmedFacts).toEqual([{ key: "material", value: "steel", source: "sheet" }]);
    expect(captured[0].brandProfile?.audience).toBe("Distributors");
    expect(result.pipeline).toMatchObject({ humanApprovalRequired: true, approvalCreated: false, publishJobCreated: false });
    expect(await db.approval.count({ where: { clientId: fixture.client.id } })).toBe(0);
    expect(await db.publishJob.count({ where: { clientId: fixture.client.id } })).toBe(0);
  });

  it("rejects structurally invalid model output", async () => {
    const adapter: TextGenerationAdapter = { async generate() { return { provider: "bad", model: null, simulated: true, usage: { inputUnits: 0, outputUnits: 0 }, output: { drafts: [] } }; } };
    await expect(runAIContentPipeline(fixture.context, { clientName: "x", mode: "DRAFT", targetMarkets: [], productFocus: null, brandGuidelines: null, productName: "x", objective: "x", theme: "x", confirmedFacts: [], missingFields: [], platforms: ["facebook"], instruction: "x" }, adapter)).rejects.toThrow();
  });
});

describe("calendar foundation", () => {
  it("filters existing records and reschedules through the tenant service", async () => {
    const original = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const target = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const { item, version } = await createContent({ status: "APPROVED", scheduledAt: original });
    await db.approval.create({
      data: {
        clientId: fixture.client.id,
        contentVersionId: version.id,
        accountId: fixture.account.id,
        reviewerId: fixture.context.userId,
        decision: "APPROVED",
      },
    });
    const job = await db.publishJob.create({ data: { clientId: fixture.client.id, contentVersionId: version.id, accountId: fixture.account.id, idempotencyKey: randomUUID(), adapter: "mock", nextAttemptAt: original } });
    expect(await listCalendarEntries(fixture.context, { platform: "linkedin" })).toHaveLength(0);
    expect(await listCalendarEntries(fixture.context, { platform: "facebook", status: "APPROVED" })).toHaveLength(1);
    await rescheduleCalendarItems(fixture.context, { contentItemIds: [item.id], scheduledAt: target });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.id } })).scheduledAt?.toISOString()).toBe(target.toISOString());
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).nextAttemptAt.toISOString()).toBe(target.toISOString());
  });

  it("blocks cross-tenant and protected-state rescheduling", async () => {
    const { item } = await createContent({ status: "PUBLISHED" });
    await expect(rescheduleCalendarItems(fixture.context, { contentItemIds: [item.id], scheduledAt: new Date(Date.now() + 86400000) })).rejects.toMatchObject({ code: "CALENDAR_ITEM_LOCKED" });
    const other = await makeFixture();
    await expect(rescheduleCalendarItems(other.context, { contentItemIds: [item.id], scheduledAt: new Date(Date.now() + 86400000) })).rejects.toMatchObject({ code: "CONTENT_SCOPE_VIOLATION" });
  });
});

describe("analytics foundation", () => {
  it("normalizes canonical metrics, compares periods and preserves unavailable values", () => {
    expect(canonicalizeMetricKey("post_comments_total:remote-1")).toEqual({ key: "comments", postId: "remote-1" });
    const now = new Date("2026-09-21T12:00:00Z");
    const bounds = periodBounds(now, "week");
    const values = aggregateMetricSnapshots([
      { accountId: "a", metricKey: "impressions", numericValue: 10 as never, availability: "AVAILABLE", dataKind: "REAL", periodStart: null, periodEnd: null, fetchedAt: new Date("2026-09-21T08:00:00Z"), account: { platform: "facebook" } },
      { accountId: "a", metricKey: "impressions", numericValue: 999 as never, availability: "AVAILABLE", dataKind: "REAL", periodStart: null, periodEnd: null, fetchedAt: new Date("2026-09-21T07:00:00Z"), account: { platform: "facebook" } },
      { accountId: "a", metricKey: "impressions", numericValue: 5 as never, availability: "AVAILABLE", dataKind: "REAL", periodStart: null, periodEnd: null, fetchedAt: new Date("2026-09-14T08:00:00Z"), account: { platform: "facebook" } },
      { accountId: "a", metricKey: "reach", numericValue: null, availability: "READ_FAILED", dataKind: "REAL", periodStart: null, periodEnd: null, fetchedAt: new Date("2026-09-21T08:00:00Z"), account: { platform: "facebook" } },
    ], bounds);
    expect(values.find((item) => item.key === "impressions")).toMatchObject({ current: 10, previous: 5, changePercent: 100 });
    expect(values.find((item) => item.key === "reach")).toMatchObject({ current: null, previous: null, unavailable: { READ_FAILED: 1 } });
  });

  it("reports freshness states without inventing data", () => {
    const now = new Date("2026-09-21T12:00:00Z");
    expect(resolveFreshness({ status: "SYNCING", now })).toBe("syncing");
    expect(resolveFreshness({ status: "FAILED", now })).toBe("failed");
    expect(resolveFreshness({ latestFetchedAt: new Date("2026-09-21T11:00:00Z"), now })).toBe("fresh");
    expect(resolveFreshness({ latestFetchedAt: new Date("2026-09-19T11:00:00Z"), now })).toBe("stale");
    expect(resolveFreshness({ now })).toBe("stale");
  });

  it("persists syncing, success and failure states with tenant-scoped accounts", async () => {
    expect((await markAnalyticsSyncStarted(fixture.context, fixture.account.id)).status).toBe("SYNCING");
    expect((await markAnalyticsSyncSucceeded(fixture.context, fixture.account.id)).status).toBe("FRESH");
    expect((await markAnalyticsSyncFailed(fixture.context, fixture.account.id, "timeout")).status).toBe("FAILED");
    const other = await makeFixture();
    await expect(markAnalyticsSyncStarted(other.context, fixture.account.id)).rejects.toThrow("ANALYTICS_ACCOUNT_SCOPE_VIOLATION");
  });
});

describe("notifications foundation", () => {
  it("creates the in-app event and records webhook/email failures without rollback", async () => {
    process.env.TEST_WEBHOOK_ENDPOINT = "https://notify.example.test/webhook";
    process.env.TEST_EMAIL_ENDPOINT = "https://notify.example.test/email";
    await db.notificationChannel.createMany({ data: [
      { clientId: fixture.client.id, type: "WEBHOOK", displayName: "Ops webhook", credentialRef: "env:TEST_WEBHOOK_ENDPOINT", status: "VERIFIED" },
      { clientId: fixture.client.id, type: "EMAIL", displayName: "Ops email", credentialRef: "env:TEST_EMAIL_ENDPOINT", status: "VERIFIED" },
    ] });
    await upsertNotificationRule(fixture.context, { eventType: "PUBLISH_UNKNOWN", severity: "URGENT", channelType: "WEBHOOK", cooldownMinutes: 60 });
    await upsertNotificationRule(fixture.context, { eventType: "PUBLISH_UNKNOWN", severity: "URGENT", channelType: "EMAIL", cooldownMinutes: 60 });
    const result = await createAndDispatchNotification(fixture.context, { eventType: "PUBLISH_UNKNOWN", title: "Remote result unknown", body: "Manual reconciliation required", urgent: true }, async ({ type }) => {
      if (type === "EMAIL") throw new Error("provider unavailable");
    });
    expect(result.notification.severity).toBe("URGENT");
    expect(result.deliveries.map((delivery) => delivery.status).sort()).toEqual(["DELIVERED", "FAILED"]);
    expect(await db.inAppNotification.count({ where: { id: result.notification.id } })).toBe(1);
    expect(await db.notificationDelivery.count({ where: { notificationId: result.notification.id } })).toBe(2);
  });
});
