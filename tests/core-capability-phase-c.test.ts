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
  dispatchPendingNotificationDeliveries,
  listNotificationInbox,
  markAllNotificationsRead,
  prepareNotificationEvent,
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

async function makePublishedPost(remotePostId: string, input: { theme?: string; assetKind?: "IMAGE" | "VIDEO"; publishedAt?: Date; account?: SocialAccount } = {}) {
  const account = input.account || fixture.account;
  const product = await db.product.create({ data: { clientId: fixture.client.id, name: `Product ${remotePostId}`, status: "CONFIRMED" } });
  const plan = await db.contentPlan.create({ data: { clientId: fixture.client.id, productId: product.id, theme: input.theme || "Theme A", objective: "Leads", channels: [account.platform] } });
  const item = await db.contentItem.create({ data: { clientId: fixture.client.id, planId: plan.id, accountId: account.id, platform: account.platform, status: "PUBLISHED" } });
  const version = await db.contentVersion.create({ data: { clientId: fixture.client.id, contentItemId: item.id, version: 1, text: `Post ${remotePostId}`, promptVersionId: fixture.promptId, generator: "test", generationLabel: "test", sourceFacts: {} } });
  if (input.assetKind) {
    const asset = await db.asset.create({ data: { clientId: fixture.client.id, kind: input.assetKind, originalName: `${remotePostId}.jpg`, mimeType: "image/jpeg", byteSize: 10, storageKey: remotePostId, checksum: remotePostId } });
    await db.contentVersionAsset.create({ data: { clientId: fixture.client.id, contentVersionId: version.id, assetId: asset.id } });
  }
  await db.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
  await db.publishJob.create({ data: { clientId: fixture.client.id, contentVersionId: version.id, accountId: account.id, idempotencyKey: randomUUID(), adapter: "test", status: "PUBLISHED", remotePostId, publishedAt: input.publishedAt || new Date() } });
  return { item, version };
}

async function metric(metricKey: string, numericValue: number | null, options: { availability?: "AVAILABLE" | "NOT_FETCHED" | "UNSUPPORTED" | "PERMISSION_DENIED" | "READ_FAILED"; fetchedAt?: Date; account?: SocialAccount; periodStart?: Date; periodEnd?: Date } = {}) {
  return db.metricSnapshot.create({ data: {
    clientId: fixture.client.id,
    accountId: options.account?.id || fixture.account.id,
    metricKey,
    numericValue,
    availability: options.availability || "AVAILABLE",
    dataKind: "REAL",
    fetchedAt: options.fetchedAt || new Date(),
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    source: "test",
  } });
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

  it("recovers a committed PENDING delivery without concurrent duplicate dispatch", async () => {
    process.env.PHASE_C_WEBHOOK = "https://notify.example.test/webhook";
    await db.notificationChannel.create({ data: { clientId: fixture.client.id, type: "WEBHOOK", displayName: "Webhook", credentialRef: "env:PHASE_C_WEBHOOK", status: "VERIFIED" } });
    await upsertNotificationRule(fixture.context, { eventType: "PUBLISH_UNKNOWN", severity: "URGENT", channelType: "WEBHOOK", cooldownMinutes: 60 });
    const prepared = await db.$transaction((tx) => prepareNotificationEvent(tx, fixture.context, {
      eventType: "PUBLISH_UNKNOWN",
      title: "Unknown",
      body: "Reconcile",
      urgent: true,
      relatedType: "PublishJob",
      relatedId: "pending-recovery",
    }));
    expect(prepared.pendingDeliveries).toHaveLength(1);
    expect(prepared.pendingDeliveries[0].delivery.status).toBe("PENDING");

    let calls = 0;
    const transport = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    const [first, second] = await Promise.all([
      dispatchPendingNotificationDeliveries(1, transport),
      dispatchPendingNotificationDeliveries(1, transport),
    ]);
    expect(calls).toBe(1);
    expect(first.length + second.length).toBe(1);
    expect(await db.notificationDelivery.findUniqueOrThrow({ where: { id: prepared.pendingDeliveries[0].delivery.id } })).toMatchObject({
      status: "DELIVERED",
      attemptCount: 1,
      lockedAt: null,
      lockedBy: null,
    });
  });

  it("reclaims an abandoned notification lease with a stable downstream delivery id", async () => {
    process.env.PHASE_C_WEBHOOK = "https://notify.example.test/webhook";
    await db.notificationChannel.create({ data: { clientId: fixture.client.id, type: "WEBHOOK", displayName: "Webhook", credentialRef: "env:PHASE_C_WEBHOOK", status: "VERIFIED" } });
    await upsertNotificationRule(fixture.context, { eventType: "PUBLISH_UNKNOWN", severity: "URGENT", channelType: "WEBHOOK", cooldownMinutes: 60 });
    const prepared = await db.$transaction((tx) => prepareNotificationEvent(tx, fixture.context, {
      eventType: "PUBLISH_UNKNOWN",
      title: "Unknown",
      body: "Reconcile",
      urgent: true,
      relatedType: "PublishJob",
      relatedId: "abandoned-delivery",
    }));
    const deliveryId = prepared.pendingDeliveries[0].delivery.id;
    await db.notificationDelivery.update({
      where: { id: deliveryId },
      data: { lockedAt: new Date(Date.now() - 120_000), lockedBy: "dead-worker", attemptCount: 1 },
    });

    const downstreamIds: string[] = [];
    const dispatched = await dispatchPendingNotificationDeliveries(1, async ({ deliveryId: stableId }) => {
      downstreamIds.push(stableId);
    }, 60);

    expect(downstreamIds).toEqual([deliveryId]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ status: "DELIVERED", attemptCount: 2, lockedAt: null, lockedBy: null });
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

  it("keeps identical remote post ids isolated by account in content filters and performance", async () => {
    const second = await db.socialAccount.create({ data: { clientId: fixture.client.id, platform: "instagram", displayName: "Second Account", metricsCapability: "VERIFIED" } });
    const firstPost = await makePublishedPost("shared-remote-id");
    const secondPost = await makePublishedPost("shared-remote-id", { account: second });
    await metric("reach:shared-remote-id", 101);
    await metric("reach:shared-remote-id", 202, { account: second });

    const firstContentMetrics = await queryAnalyticsMetrics(fixture.context, { contentItemId: firstPost.item.id });
    const secondContentMetrics = await queryAnalyticsMetrics(fixture.context, { contentItemId: secondPost.item.id });
    expect(firstContentMetrics).toHaveLength(1);
    expect(firstContentMetrics[0].accountId).toBe(fixture.account.id);
    expect(Number(firstContentMetrics[0].numericValue)).toBe(101);
    expect(secondContentMetrics).toHaveLength(1);
    expect(secondContentMetrics[0].accountId).toBe(second.id);
    expect(Number(secondContentMetrics[0].numericValue)).toBe(202);

    const performance = await getContentPerformance(fixture.context, { sortBy: "reach" });
    expect(performance.find((row) => row.account.id === fixture.account.id)?.reach).toBe(101);
    expect(performance.find((row) => row.account.id === second.id)?.reach).toBe(202);

    await expect(comparePosts(fixture.context, ["shared-remote-id", { accountId: fixture.account.id, remotePostId: "shared-remote-id" }]))
      .rejects.toMatchObject({ code: "AMBIGUOUS_POST_ID" });
    const exactComparison = await comparePosts(fixture.context, [
      { accountId: fixture.account.id, remotePostId: "shared-remote-id" },
      { accountId: second.id, remotePostId: "shared-remote-id" },
    ]);
    expect(exactComparison.map((row) => [row.account.id, row.reach])).toEqual([
      [fixture.account.id, 101],
      [second.id, 202],
    ]);
  });

  it("matches a content item's complete case-sensitive remote post id", async () => {
    const post = await makePublishedPost("AbC123");
    await metric("reach:AbC123", 42);
    await metric("reach:other-AbC123", 999);
    const metrics = await queryAnalyticsMetrics(fixture.context, { contentItemId: post.item.id });
    expect(metrics.map((entry) => entry.metricKey)).toEqual(["reach:AbC123"]);
    const performance = await getContentPerformance(fixture.context, { contentItemId: post.item.id });
    expect(performance[0].reach).toBe(42);
  });

  it("uses the most recently fetched post metric across period snapshots", async () => {
    const post = await makePublishedPost("period-post");
    await metric("views:period-post", 10, {
      fetchedAt: new Date("2026-09-03T00:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-09-02T00:00:00Z"),
    });
    await metric("views:period-post", 30, {
      fetchedAt: new Date("2026-09-03T01:00:00Z"),
      periodStart: new Date("2026-09-02T00:00:00Z"),
      periodEnd: new Date("2026-09-03T00:00:00Z"),
    });

    const performance = await getContentPerformance(fixture.context, { contentItemId: post.item.id });
    expect(performance).toHaveLength(1);
    expect(performance[0].views).toBe(30);
  });

  it("compares tenant-scoped accounts from deduplicated canonical snapshots", async () => {
    const second = await db.socialAccount.create({ data: { clientId: fixture.client.id, platform: "instagram", displayName: "Second Account", metricsCapability: "VERIFIED" } });
    const firstPeriodStart = new Date("2026-09-01T00:00:00Z");
    const firstPeriodEnd = new Date("2026-09-02T00:00:00Z");
    const secondPeriodStart = new Date("2026-09-02T00:00:00Z");
    const secondPeriodEnd = new Date("2026-09-03T00:00:00Z");
    await metric("reach", 9, { fetchedAt: new Date("2026-09-03T00:00:00Z"), periodStart: firstPeriodStart, periodEnd: firstPeriodEnd });
    await metric("reach", 10, { fetchedAt: new Date("2026-09-03T01:00:00Z"), periodStart: firstPeriodStart, periodEnd: firstPeriodEnd });
    await metric("reach", 5, { fetchedAt: new Date("2026-09-03T01:00:00Z"), periodStart: secondPeriodStart, periodEnd: secondPeriodEnd });
    await metric("reach:fixture-post", 999);
    await db.metricSnapshot.create({ data: { clientId: fixture.client.id, accountId: second.id, metricKey: "reach", numericValue: 20, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "test" } });
    await metric("reach:second-post", 888, { account: second });
    const comparison = await compareAccounts(fixture.context, [fixture.account.id, second.id], "reach");
    expect(comparison.map((entry) => entry.value).sort((a, b) => Number(a) - Number(b))).toEqual([15, 20]);
    expect(comparison.find((entry) => entry.account.id === fixture.account.id)?.sampleSize).toBe(2);
  });

  it("uses minimum sample thresholds for explainable patterns", async () => {
    await makePublishedPost("sample-one", { assetKind: "VIDEO" });
    await metric("views:sample-one", 100);
    expect(await analyzePerformancePatterns(fixture.context, { dimension: "media_type", metric: "views", minimumSampleSize: 2 })).toEqual([
      { group: "VIDEO", metric: "views", sampleSize: 1, status: "INSUFFICIENT_DATA", average: null, timezone: "Asia/Shanghai" },
    ]);
  });

  it("groups publish day in the tenant timezone across a UTC date boundary", async () => {
    await makePublishedPost("shanghai-cross-day", { publishedAt: new Date("2026-09-06T16:30:00Z") });
    await metric("views:shanghai-cross-day", 10);

    expect(await analyzePerformancePatterns(fixture.context, { dimension: "publish_day", metric: "views", minimumSampleSize: 2 })).toEqual([
      { group: "Monday", metric: "views", sampleSize: 1, status: "INSUFFICIENT_DATA", average: null, timezone: "Asia/Shanghai" },
    ]);
  });

  it("groups repeated local hours consistently across New York DST fallback", async () => {
    await db.client.update({ where: { id: fixture.client.id }, data: { timezone: "America/New_York" } });
    await makePublishedPost("new-york-edt", { publishedAt: new Date("2026-11-01T05:30:00Z") });
    await makePublishedPost("new-york-est", { publishedAt: new Date("2026-11-01T06:30:00Z") });
    await metric("views:new-york-edt", 10);
    await metric("views:new-york-est", 20);

    expect(await analyzePerformancePatterns(fixture.context, { dimension: "publish_hour", metric: "views", minimumSampleSize: 2 })).toEqual([
      { group: "01", metric: "views", sampleSize: 2, status: "AVAILABLE", average: 15, timezone: "America/New_York" },
    ]);
  });

  it("reports health states and review labels without causal claims", async () => {
    await metric("reach", null, { availability: "PERMISSION_DENIED" });
    expect((await getAnalyticsDataHealth(fixture.context))[0].status).toBe("permission_denied");
    const review = buildAnalyticsReview([{ label: "Video average views", value: 100, sampleSize: 3 }]);
    expect(review.map((entry) => entry.type)).toEqual(["FACT", "OBSERVATION", "HYPOTHESIS", "RECOMMENDATION"]);
    expect(review.map((entry) => entry.text).join(" ").toLowerCase()).toContain("causation is not established");
  });

  it("derives analytics health from the latest snapshot of each metric dimension", async () => {
    const now = new Date();
    await metric("reach", null, { availability: "PERMISSION_DENIED", fetchedAt: new Date(now.getTime() - 20_000) });
    await metric("reach", 100, { fetchedAt: new Date(now.getTime() - 10_000) });
    await metric("views:health-post", null, { availability: "UNSUPPORTED", fetchedAt: new Date(now.getTime() - 20_000) });
    await metric("views:health-post", 200, { fetchedAt: new Date(now.getTime() - 10_000) });

    expect((await getAnalyticsDataHealth(fixture.context, now))[0].status).toBe("fresh");
  });
});
