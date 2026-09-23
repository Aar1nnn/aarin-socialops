import { randomUUID } from "node:crypto";
import type { Client, SocialAccount } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import {
  analyzePerformancePatterns,
  buildAnalyticsReview,
  compareAccounts,
  comparePosts,
  getAnalyticsDataHealth,
  getContentPerformance,
  queryAnalyticsMetrics,
  selectLatestMetricSnapshots,
} from "../src/services/analytics-service";
import {
  createAndDispatchNotification,
  listNotificationInbox,
  markAllNotificationsRead,
  setNotificationReadState,
  upsertNotificationRule,
} from "../src/services/notification-service";

type Fixture = { client: Client; account: SocialAccount; context: RequestContext; promptId: string };
const clientIds: string[] = [];
const userIds: string[] = [];
let fixture: Fixture;

async function makeFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `phase-c-${suffix}`, name: `Phase C ${suffix}` } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `phase-c-${suffix}@example.local`, displayName: "Phase C", passwordHash: "unused" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "Phase C Page", metricsCapability: "VERIFIED" } });
  const prompt = await db.promptVersion.create({ data: { clientId: client.id, capability: "multi_platform_content", version: suffix, instruction: "Facts", schemaName: "GeneratedDrafts", modelConfig: {} } });
  return { client, account, promptId: prompt.id, context: { clientId: client.id, userId: user.id, role: "OWNER" } };
}

async function makePublishedPost(remotePostId: string, input: { theme?: string; assetKind?: "IMAGE" | "VIDEO"; publishedAt?: Date } = {}) {
  const product = await db.product.create({ data: { clientId: fixture.client.id, name: `Product ${remotePostId}`, status: "CONFIRMED" } });
  const plan = await db.contentPlan.create({ data: { clientId: fixture.client.id, productId: product.id, theme: input.theme || "Theme A", objective: "Leads", channels: ["facebook"] } });
  const item = await db.contentItem.create({ data: { clientId: fixture.client.id, planId: plan.id, accountId: fixture.account.id, platform: "facebook", status: "PUBLISHED" } });
  const version = await db.contentVersion.create({ data: { clientId: fixture.client.id, contentItemId: item.id, version: 1, text: `Post ${remotePostId}`, promptVersionId: fixture.promptId, generator: "test", generationLabel: "test", sourceFacts: {} } });
  if (input.assetKind) {
    const asset = await db.asset.create({ data: { clientId: fixture.client.id, kind: input.assetKind, originalName: `${remotePostId}.jpg`, mimeType: "image/jpeg", byteSize: 10, storageKey: remotePostId, checksum: remotePostId } });
    await db.contentVersionAsset.create({ data: { clientId: fixture.client.id, contentVersionId: version.id, assetId: asset.id } });
  }
  await db.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
  await db.publishJob.create({ data: { clientId: fixture.client.id, contentVersionId: version.id, accountId: fixture.account.id, idempotencyKey: randomUUID(), adapter: "test", status: "PUBLISHED", remotePostId, publishedAt: input.publishedAt || new Date() } });
  return { item, version };
}

async function metric(metricKey: string, numericValue: number | null, options: { availability?: "AVAILABLE" | "NOT_FETCHED" | "UNSUPPORTED" | "PERMISSION_DENIED" | "READ_FAILED"; fetchedAt?: Date } = {}) {
  return db.metricSnapshot.create({ data: { clientId: fixture.client.id, accountId: fixture.account.id, metricKey, numericValue, availability: options.availability || "AVAILABLE", dataKind: "REAL", fetchedAt: options.fetchedAt || new Date(), source: "test" } });
}

beforeEach(async () => { fixture = await makeFixture(); });
afterEach(async () => {
  delete process.env.PHASE_C_EMAIL;
  delete process.env.PHASE_C_WEBHOOK;
  for (const clientId of clientIds.splice(0)) {
    await db.contentVersionAsset.deleteMany({ where: { clientId } });
    await db.client.deleteMany({ where: { id: clientId } });
  }
  for (const userId of userIds.splice(0)) await db.user.deleteMany({ where: { id: userId } });
});
afterAll(async () => { await db.$disconnect(); });

describe("notification rules and inbox", () => {
  it("matches finite event rules and selects only configured external channels", async () => {
    process.env.PHASE_C_EMAIL = "https://notify.example.test/email";
    process.env.PHASE_C_WEBHOOK = "https://notify.example.test/webhook";
    await db.notificationChannel.createMany({ data: [
      { clientId: fixture.client.id, type: "EMAIL", displayName: "Email", credentialRef: "env:PHASE_C_EMAIL", status: "VERIFIED" },
      { clientId: fixture.client.id, type: "WEBHOOK", displayName: "Webhook", credentialRef: "env:PHASE_C_WEBHOOK", status: "VERIFIED" },
    ] });
    await upsertNotificationRule(fixture.context, { eventType: "PUBLISH_FAILED", severity: "NORMAL", channelType: "EMAIL", cooldownMinutes: 60 });
    const delivered: string[] = [];
    const result = await createAndDispatchNotification(fixture.context, { eventType: "PUBLISH_FAILED", title: "Failed", body: "Retry exhausted" }, async ({ type }) => { delivered.push(type); });
    expect(result.selectedChannels).toEqual(["IN_APP", "EMAIL"]);
    expect(delivered).toEqual(["EMAIL"]);
    expect(result.deliveries).toHaveLength(1);
  });

  it("deduplicates repeated events during cooldown without repeated delivery", async () => {
    process.env.PHASE_C_EMAIL = "https://notify.example.test/email";
    await db.notificationChannel.create({ data: { clientId: fixture.client.id, type: "EMAIL", displayName: "Email", credentialRef: "env:PHASE_C_EMAIL", status: "VERIFIED" } });
    await upsertNotificationRule(fixture.context, { eventType: "TOKEN_EXPIRED", severity: "URGENT", channelType: "EMAIL", cooldownMinutes: 60 });
    let calls = 0;
    const transport = async () => { calls += 1; };
    const event = { eventType: "TOKEN_EXPIRED" as const, title: "Expired", body: "Reconnect", urgent: true, relatedType: "account", relatedId: fixture.account.id };
    const [first, second] = await Promise.all([
      createAndDispatchNotification(fixture.context, event, transport),
      createAndDispatchNotification(fixture.context, event, transport),
    ]);
    expect([first.deduplicated, second.deduplicated].sort()).toEqual([false, true]);
    expect(calls).toBe(1);
    expect((await db.inAppNotification.findFirstOrThrow({ where: { clientId: fixture.client.id } })).occurrenceCount).toBe(2);
    expect(await db.inAppNotification.count({ where: { clientId: fixture.client.id } })).toBe(1);
  });

  it("isolates delivery failure and supports unread, important, read, unread and mark-all operations", async () => {
    process.env.PHASE_C_WEBHOOK = "https://notify.example.test/webhook";
    await db.notificationChannel.create({ data: { clientId: fixture.client.id, type: "WEBHOOK", displayName: "Webhook", credentialRef: "env:PHASE_C_WEBHOOK", status: "VERIFIED" } });
    await upsertNotificationRule(fixture.context, { eventType: "PUBLISH_UNKNOWN", severity: "URGENT", channelType: "WEBHOOK", cooldownMinutes: 60 });
    const created = await createAndDispatchNotification(fixture.context, { eventType: "PUBLISH_UNKNOWN", title: "Unknown", body: "Reconcile", urgent: true }, async () => { throw new Error("provider unavailable"); });
    expect(created.deliveries[0].status).toBe("FAILED");
    expect(await db.inAppNotification.count({ where: { id: created.notification.id } })).toBe(1);
    expect(await listNotificationInbox(fixture.context, { view: "unread" })).toHaveLength(1);
    expect(await listNotificationInbox(fixture.context, { view: "important" })).toHaveLength(1);
    await setNotificationReadState(fixture.context, created.notification.id, true);
    expect(await listNotificationInbox(fixture.context, { view: "unread" })).toHaveLength(0);
    await setNotificationReadState(fixture.context, created.notification.id, false);
    expect((await markAllNotificationsRead(fixture.context)).updated).toBe(1);
    const other = await makeFixture();
    await expect(setNotificationReadState(other.context, created.notification.id, true)).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
  });
});

describe("analytics query and analysis", () => {
  it("selects the latest canonical snapshot while preserving missing distinct from zero", async () => {
    const older = new Date(Date.now() - 10_000);
    await metric("views:post-a", 99, { fetchedAt: older });
    await metric("views:post-a", 0);
    await metric("reach:post-a", null, { availability: "NOT_FETCHED" });
    const queried = await queryAnalyticsMetrics(fixture.context, { latestOnly: true });
    expect(queried.find((row) => row.canonical.key === "views")?.numericValue?.toString()).toBe("0");
    expect(queried.find((row) => row.canonical.key === "reach")).toMatchObject({ numericValue: null, availability: "NOT_FETCHED" });
    expect(selectLatestMetricSnapshots(queried.filter((row) => row.canonical.key === "views"))).toHaveLength(1);
  });

  it("returns sortable content performance and post comparisons", async () => {
    await makePublishedPost("post-a", { assetKind: "VIDEO" });
    await makePublishedPost("post-b", { assetKind: "IMAGE" });
    await metric("reach:post-a", 100);
    await metric("views:post-a", 200);
    await metric("engagement:post-a", 20);
    await metric("reach:post-b", 50);
    await metric("views:post-b", 80);
    await metric("engagement:post-b", 5);
    const performance = await getContentPerformance(fixture.context, { sortBy: "views" });
    expect(performance.map((row) => row.remotePostId)).toEqual(["post-a", "post-b"]);
    expect(performance[0]).toMatchObject({ reach: 100, views: 200, engagement: 20, engagementRate: 0.2, mediaType: "VIDEO" });
    expect(await comparePosts(fixture.context, ["post-b", "post-a"])).toHaveLength(2);
  });

  it("compares tenant-scoped accounts from deduplicated canonical snapshots", async () => {
    const second = await db.socialAccount.create({ data: { clientId: fixture.client.id, platform: "instagram", displayName: "Second Account", metricsCapability: "VERIFIED" } });
    await metric("reach", 10);
    await db.metricSnapshot.create({ data: { clientId: fixture.client.id, accountId: second.id, metricKey: "reach", numericValue: 20, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "test" } });
    const comparison = await compareAccounts(fixture.context, [fixture.account.id, second.id], "reach");
    expect(comparison.map((entry) => entry.value).sort((a, b) => Number(a) - Number(b))).toEqual([10, 20]);
  });

  it("uses minimum sample thresholds for explainable patterns", async () => {
    await makePublishedPost("sample-one", { assetKind: "VIDEO" });
    await metric("views:sample-one", 100);
    expect(await analyzePerformancePatterns(fixture.context, { dimension: "media_type", metric: "views", minimumSampleSize: 2 })).toEqual([
      { group: "VIDEO", metric: "views", sampleSize: 1, status: "INSUFFICIENT_DATA", average: null },
    ]);
  });

  it("reports health states and review labels without causal claims", async () => {
    await metric("reach", null, { availability: "PERMISSION_DENIED" });
    expect((await getAnalyticsDataHealth(fixture.context))[0].status).toBe("permission_denied");
    const review = buildAnalyticsReview([{ label: "Video average views", value: 100, sampleSize: 3 }]);
    expect(review.map((entry) => entry.type)).toEqual(["FACT", "OBSERVATION", "HYPOTHESIS", "RECOMMENDATION"]);
    expect(review.map((entry) => entry.text).join(" ").toLowerCase()).toContain("causation is not established");
  });
});
