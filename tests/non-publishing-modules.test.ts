import { randomUUID } from "node:crypto";
import type { Client, ContentItem, ContentVersion, SocialAccount, User } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiReviewSchema } from "../src/lib/ai-content-contracts";
import { MockAiContentStageAdapter } from "../src/lib/adapters/ai-content";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import { aggregateMetricSnapshots, canonicalMetricKey, getSocialAnalytics, metricFreshness } from "../src/services/analytics-service";
import { buildAiPipelineContext, runAiContentPipeline } from "../src/services/ai-content-service";
import { buildBrandContext, getBrandProfile, upsertBrandProfile } from "../src/services/brand-service";
import { bulkRescheduleCalendarItems, listCalendarEntries, rescheduleCalendarItem } from "../src/services/calendar-service";
import { buildStructuredMemory } from "../src/services/memory-service";
import { createOperationalNotification, notificationChannelSchema, type NotificationDispatcher } from "../src/services/notification-service";

type Fixture = {
  client: Client;
  user: User;
  context: RequestContext;
  account: SocialAccount;
  item: ContentItem;
  version: ContentVersion;
};

const clientIds: string[] = [];
const userIds: string[] = [];
let fixture: Fixture;

async function makeFixture(label = "primary"): Promise<Fixture> {
  const token = randomUUID();
  const client = await db.client.create({ data: { slug: `${label}-${token}`, name: `${label} client`, mode: "DEMO", isDemo: true, brandGuidelines: `${label} legacy guidelines` } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `${label}-${token}@example.local`, displayName: label, passwordHash: "test" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: `${label} Facebook`, publishCapability: "VERIFIED" } });
  await db.platformPolicy.create({ data: { clientId: client.id, platform: "facebook", maxTextLength: 500, source: "test" } });
  const prompt = await db.promptVersion.create({ data: { clientId: client.id, capability: "ai_content_pipeline", version: "test-1", instruction: "test", schemaName: "AiPipeline", modelConfig: {} } });
  const product = await db.product.create({
    data: {
      clientId: client.id,
      name: `${label} chair`,
      status: "CONFIRMED",
      fields: { create: [
        { clientId: client.id, key: "material", value: `${label} confirmed steel`, status: "CONFIRMED", source: "customer sheet" },
        { clientId: client.id, key: "size", value: `${label} proposed size`, status: "PROPOSED", source: "model guess" },
      ] },
    },
  });
  const plan = await db.contentPlan.create({ data: { clientId: client.id, productId: product.id, theme: `${label} theme`, objective: "qualified enquiries", channels: ["facebook"] } });
  const item = await db.contentItem.create({ data: { clientId: client.id, planId: plan.id, accountId: account.id, platform: "facebook" } });
  const version = await db.contentVersion.create({ data: { clientId: client.id, contentItemId: item.id, version: 1, text: `${label} hook. Contact us for details.`, productDataVersion: 1, promptVersionId: prompt.id, generator: "fixture", simulated: true, generationLabel: "fixture", sourceFacts: {} } });
  const current = await db.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
  return { client, user, context: { clientId: client.id, userId: user.id, role: "OWNER" }, account, item: current, version };
}

beforeEach(async () => {
  fixture = await makeFixture();
});

afterEach(async () => {
  for (const clientId of clientIds.splice(0)) await db.client.deleteMany({ where: { id: clientId } });
  for (const userId of userIds.splice(0)) await db.user.deleteMany({ where: { id: userId } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("brand and structured memory", () => {
  it("keeps brand profiles tenant scoped and preserves legacy compatibility", async () => {
    const other = await makeFixture("other");
    expect((await buildBrandContext(fixture.context)).source).toBe("LEGACY");
    await upsertBrandProfile(fixture.context, { businessSummary: "Structured primary brand", voiceTraits: ["direct"], goals: [], contentLanguages: ["en"], bannedPhrases: [], requiredMentions: [], ctaRules: [] });
    expect((await getBrandProfile(fixture.context))?.businessSummary).toBe("Structured primary brand");
    expect(await getBrandProfile(other.context)).toBeNull();
    expect((await buildBrandContext(other.context)).businessSummary).toContain("other legacy guidelines");
  });

  it("extracts recent content and aggregates performance/research without cross-tenant leakage", async () => {
    const other = await makeFixture("other");
    await db.metricSnapshot.createMany({ data: [
      { clientId: fixture.client.id, accountId: fixture.account.id, contentItemId: fixture.item.id, metricKey: "views", numericValue: 12, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "primary" },
      { clientId: other.client.id, accountId: other.account.id, contentItemId: other.item.id, metricKey: "views", numericValue: 999, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "other" },
    ] });
    await db.researchRecord.createMany({ data: [
      { clientId: fixture.client.id, kind: "MARKET", objective: "primary research", observedAt: new Date(), observations: [], inferences: [], experiments: [], limitations: [] },
      { clientId: other.client.id, kind: "MARKET", objective: "other secret research", observedAt: new Date(), observations: [], inferences: [], experiments: [], limitations: [] },
    ] });
    const memory = await buildStructuredMemory(fixture.context);
    expect(memory.content.recentHooks.join(" ")).toContain("primary hook");
    expect(JSON.stringify(memory)).not.toContain("other hook");
    expect(memory.performance.find((entry) => entry.metricKey === "views")?.availableTotal).toBe(12);
    expect(memory.research.map((record) => record.objective)).toEqual(["primary research"]);
  });
});

describe("AI content foundation", () => {
  it("builds context from CONFIRMED product facts only", async () => {
    const context = await buildAiPipelineContext(fixture.context, fixture.item.id);
    expect(context.confirmedFacts).toEqual([{ key: "material", value: "primary confirmed steel", source: "customer sheet" }]);
    expect(JSON.stringify(context.confirmedFacts)).not.toContain("proposed size");
    expect(context.missingFactKeys).toContain("size");
  });

  it("validates stage output and keeps AI review separate from human approval and publishing", async () => {
    expect(() => aiReviewSchema.parse({ verdict: "PASS", score: 101, issues: [] })).toThrow();
    const result = await runAiContentPipeline(fixture.context, fixture.item.id, { intent: "Introduce confirmed material" }, new MockAiContentStageAdapter());
    expect(result.approvalRequired).toBe(true);
    expect(result.publishJobCreated).toBe(false);
    expect(await db.aiContentReview.count({ where: { clientId: fixture.client.id, contentVersionId: result.version.id } })).toBe(1);
    expect(await db.approval.count({ where: { clientId: fixture.client.id, contentVersionId: result.version.id } })).toBe(0);
    expect(await db.publishJob.count({ where: { clientId: fixture.client.id, contentVersionId: result.version.id } })).toBe(0);
    expect(JSON.stringify(result.version.sourceFacts)).not.toContain("proposed size");
  });

  it("rejects a stage that claims it used an unconfirmed fact key", async () => {
    const unsafe = new MockAiContentStageAdapter();
    unsafe.generate = async (context, strategy) => ({ ...(await MockAiContentStageAdapter.prototype.generate.call(unsafe, context, strategy)), usedFactKeys: ["size"] });
    await expect(runAiContentPipeline(fixture.context, fixture.item.id, { intent: "Use every detail" }, unsafe)).rejects.toMatchObject({ code: "AI_UNCONFIRMED_FACT_USED" });
    expect(await db.aiContentReview.count({ where: { clientId: fixture.client.id } })).toBe(0);
  });

  it("does not overwrite a newer product context after an AI-stage race", async () => {
    const item = await db.contentItem.findUniqueOrThrow({ where: { id: fixture.item.id }, include: { plan: true } });
    const racing = new MockAiContentStageAdapter();
    racing.shorten = async (context, rewrite) => {
      await db.product.update({ where: { id: item.plan.productId! }, data: { dataVersion: { increment: 1 } } });
      return MockAiContentStageAdapter.prototype.shorten.call(racing, context, rewrite);
    };
    await expect(runAiContentPipeline(fixture.context, fixture.item.id, { intent: "Race-safe draft" }, racing)).rejects.toMatchObject({ code: "STALE_OPERATION" });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: fixture.item.id } })).currentVersionId).toBe(fixture.version.id);
  });
});

describe("calendar foundation", () => {
  async function makeScheduled() {
    const scheduledAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.approval.create({ data: { clientId: fixture.client.id, contentVersionId: fixture.version.id, accountId: fixture.account.id, reviewerId: fixture.user.id, decision: "APPROVED" } });
    const job = await db.publishJob.create({ data: { clientId: fixture.client.id, contentVersionId: fixture.version.id, accountId: fixture.account.id, platform: "facebook", idempotencyKey: randomUUID(), adapter: "mock-social", simulated: true, environment: "SIMULATED", nextAttemptAt: scheduledAt } });
    await db.contentItem.update({ where: { id: fixture.item.id }, data: { status: "SCHEDULED", scheduledAt } });
    return { scheduledAt, job };
  }

  it("filters tenant entries and reschedules through the service while preserving approval constraints", async () => {
    const { job } = await makeScheduled();
    const other = await makeFixture("other");
    const movedTo = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const entries = await listCalendarEntries(fixture.context, { from: new Date(), to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), platform: "facebook" });
    expect(entries.map((entry) => entry.id)).toContain(fixture.item.id);
    expect(entries.map((entry) => entry.id)).not.toContain(other.item.id);
    await rescheduleCalendarItem(fixture.context, fixture.item.id, movedTo);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: fixture.item.id } })).scheduledAt?.getTime()).toBe(movedTo.getTime());
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).nextAttemptAt.getTime()).toBe(movedTo.getTime());
    await expect(rescheduleCalendarItem(other.context, fixture.item.id, new Date(Date.now() + 96 * 60 * 60 * 1000))).rejects.toMatchObject({ code: "CALENDAR_ITEM_NOT_FOUND" });
  });

  it("does not move a scheduled item after human approval is revoked", async () => {
    const { scheduledAt } = await makeScheduled();
    await db.approval.create({ data: { clientId: fixture.client.id, contentVersionId: fixture.version.id, accountId: fixture.account.id, reviewerId: fixture.user.id, decision: "REJECTED" } });
    await expect(rescheduleCalendarItem(fixture.context, fixture.item.id, new Date(Date.now() + 80 * 60 * 60 * 1000))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: fixture.item.id } })).scheduledAt?.getTime()).toBe(scheduledAt.getTime());
  });

  it("keeps bulk rescheduling atomic when any tenant item is invalid", async () => {
    const { scheduledAt } = await makeScheduled();
    const other = await makeFixture("other");
    await expect(bulkRescheduleCalendarItems(fixture.context, { changes: [
      { contentItemId: fixture.item.id, scheduledAt: new Date(Date.now() + 70 * 60 * 60 * 1000) },
      { contentItemId: other.item.id, scheduledAt: new Date(Date.now() + 71 * 60 * 60 * 1000) },
    ] })).rejects.toMatchObject({ code: "CALENDAR_ITEM_NOT_FOUND" });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: fixture.item.id } })).scheduledAt?.getTime()).toBe(scheduledAt.getTime());
  });
});

describe("social analytics foundation", () => {
  it("normalizes canonical keys and keeps missing values distinct from a real zero", () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    const currentStart = new Date("2026-09-14T00:00:00.000Z");
    const currentEnd = new Date("2026-09-22T00:00:00.000Z");
    const previousStart = new Date("2026-09-06T00:00:00.000Z");
    const row = (metricKey: string, numericValue: number | null, availability: "AVAILABLE" | "READ_FAILED", fetchedAt: string) => ({ metricKey, numericValue, availability, dataKind: "REAL" as const, periodEnd: new Date(fetchedAt), fetchedAt: new Date(fetchedAt), accountId: "a", contentItemId: null, account: { platform: "facebook" } });
    const result = aggregateMetricSnapshots([
      row("plays", 10, "AVAILABLE", "2026-09-10T00:00:00.000Z"),
      row("plays", 0, "AVAILABLE", "2026-09-20T00:00:00.000Z"),
      row("post_comments_total:remote-post", 4, "AVAILABLE", "2026-09-19T00:00:00.000Z"),
      row("post_comments_total:remote-post", 7, "AVAILABLE", "2026-09-20T02:00:00.000Z"),
      row("views", null, "READ_FAILED", "2026-09-20T01:00:00.000Z"),
    ], { currentStart, currentEnd, previousStart, granularity: "day" }, now);
    expect(canonicalMetricKey("outbound-clicks")).toBe("link_clicks");
    const videoViews = result.metrics.find((metric) => metric.metricKey === "video_views")!;
    expect(videoViews.current.value).toBe(0);
    expect(videoViews.previous.value).toBe(10);
    expect(videoViews.changePercent).toBe(-100);
    const views = result.metrics.find((metric) => metric.metricKey === "views")!;
    expect(views.current.value).toBeNull();
    expect(views.freshness).toBe("failed");
    expect(result.metrics.find((metric) => metric.metricKey === "comments")?.current.value).toBe(7);
    expect(metricFreshness(undefined, now)).toBe("syncing");
  });

  it("filters database aggregation by client and retains REAL/MOCK provenance", async () => {
    const other = await makeFixture("other");
    const now = new Date();
    await db.metricSnapshot.createMany({ data: [
      { clientId: fixture.client.id, accountId: fixture.account.id, contentItemId: fixture.item.id, metricKey: "impressions", numericValue: 5, availability: "AVAILABLE", dataKind: "MOCK", fetchedAt: now, source: "primary" },
      { clientId: other.client.id, accountId: other.account.id, metricKey: "impressions", numericValue: 500, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: now, source: "other" },
    ] });
    const result = await getSocialAnalytics(fixture.context, { currentStart: new Date(now.getTime() - 24 * 60 * 60 * 1000), currentEnd: new Date(now.getTime() + 1000), granularity: "day", contentItemId: fixture.item.id });
    const impressions = result.metrics.find((metric) => metric.metricKey === "impressions")!;
    expect(impressions.current.value).toBe(5);
    expect(impressions.current.dataKinds).toEqual(["MOCK"]);
  });
});

describe("notifications foundation", () => {
  it("rejects loopback endpoints and embedded credentials", () => {
    expect(() => notificationChannelSchema.parse({ type: "WEBHOOK", displayName: "unsafe", endpoint: "https://localhost/hook?token=secret" })).toThrow();
    expect(() => notificationChannelSchema.parse({ type: "WEBHOOK", displayName: "invalid", endpoint: "not-a-url" })).toThrow();
  });

  it("dispatches both verified webhook and email channels", async () => {
    const other = await makeFixture("other");
    await db.notificationChannel.createMany({ data: [
      { clientId: fixture.client.id, type: "WEBHOOK", displayName: "webhook", status: "VERIFIED", publicConfig: { endpoint: "https://example.invalid/hook" }, verifiedAt: new Date() },
      { clientId: fixture.client.id, type: "EMAIL", displayName: "email", status: "VERIFIED", publicConfig: { endpoint: "https://example.invalid/mail", recipient: "ops@example.local" }, verifiedAt: new Date() },
      { clientId: other.client.id, type: "WEBHOOK", displayName: "other webhook", status: "VERIFIED", publicConfig: { endpoint: "https://example.invalid/other" }, verifiedAt: new Date() },
    ] });
    const sent: Array<{ clientId: string; type: string }> = [];
    const dispatcher: NotificationDispatcher = { async send(channel) { sent.push({ clientId: channel.clientId, type: channel.type }); } };
    const result = await createOperationalNotification(fixture.client.id, { type: "HIGH_PRIORITY_TASK", title: "Task", body: "Action required" }, dispatcher);
    expect(sent.map((channel) => channel.type).sort()).toEqual(["EMAIL", "WEBHOOK"]);
    expect(sent.every((channel) => channel.clientId === fixture.client.id)).toBe(true);
    expect(result.deliveries.every((delivery) => delivery.delivered)).toBe(true);
  });

  it("persists the in-app event even when external dispatch fails", async () => {
    await db.notificationChannel.create({ data: { clientId: fixture.client.id, type: "WEBHOOK", displayName: "failing webhook", status: "VERIFIED", publicConfig: { endpoint: "https://example.invalid/hook" }, verifiedAt: new Date() } });
    const failing: NotificationDispatcher = { async send() { throw new Error("gateway unavailable"); } };
    const result = await createOperationalNotification(fixture.client.id, { type: "PUBLISH_FAILED", title: "Publish failed", body: "Manual action required", relatedId: fixture.item.id }, failing);
    expect(result.deliveries).toEqual([expect.objectContaining({ delivered: false, error: "gateway unavailable" })]);
    expect(await db.inAppNotification.count({ where: { id: result.notification.id, clientId: fixture.client.id } })).toBe(1);
    expect((await db.notificationChannel.findFirstOrThrow({ where: { clientId: fixture.client.id, type: "WEBHOOK" } })).lastError).toBe("gateway unavailable");
  });
});
