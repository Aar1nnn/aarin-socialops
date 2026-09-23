import { randomUUID } from "node:crypto";
import type { Client, Prisma, SocialAccount } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import {
  classifyMediaAvailability,
  detectDuplicateAsset,
  getAssetUsage,
  searchAssets,
  setAssetTags,
} from "../src/services/asset-library-service";
import {
  assignContentToQueue,
  bulkRescheduleWithResults,
  detectScheduleConflict,
  getQueueOccurrences,
  upsertScheduleQueue,
} from "../src/services/schedule-queue-service";
import { generateContentPlan, reviewContent, submitForReview } from "../src/services/content-service";

type Fixture = { client: Client; account: SocialAccount; context: RequestContext; productId: string; promptId: string };
const clientIds: string[] = [];
const userIds: string[] = [];
let fixture: Fixture;

async function makeFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `phase-b-${suffix}`, name: `Phase B ${suffix}`, mode: "DEMO", timezone: "Asia/Shanghai" } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `phase-b-${suffix}@example.local`, displayName: "Phase B", passwordHash: "unused" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "Phase B Page", publishCapability: "VERIFIED" } });
  await db.platformPolicy.create({ data: { clientId: client.id, platform: "facebook", source: "test" } });
  const prompt = await db.promptVersion.create({ data: { clientId: client.id, capability: "multi_platform_content", version: suffix, instruction: "Facts only", schemaName: "GeneratedDrafts", modelConfig: {} } });
  const product = await db.product.create({ data: { clientId: client.id, name: "Test product", status: "CONFIRMED" } });
  return { client, account, productId: product.id, promptId: prompt.id, context: { clientId: client.id, userId: user.id, role: "OWNER" } };
}

async function makeAsset(target = fixture, suffix: string = randomUUID(), metadata: Prisma.InputJsonValue = {}) {
  return db.asset.create({ data: { clientId: target.client.id, kind: "IMAGE", originalName: `chair-${suffix}.jpg`, mimeType: "image/jpeg", byteSize: 1234, storageProvider: "local", storageKey: `asset/${suffix}`, checksum: `sha-${suffix}`, metadata } });
}

async function createItem(target = fixture, approved = true) {
  const generated = await generateContentPlan(target.context, { productId: target.productId, theme: "Queue test", objective: "Leads", accountIds: [target.account.id], assetIds: [] });
  const item = generated.items[0];
  if (approved) {
    await submitForReview(target.context, item.id);
    await reviewContent(target.context, item.id, "APPROVED");
  }
  return db.contentItem.findUniqueOrThrow({ where: { id: item.id }, include: { currentVersion: true } });
}

function nextLocalSlot(after: Date) {
  const local = new Date(after.getTime() + 8 * 60 * 60 * 1000);
  local.setUTCDate(local.getUTCDate() + 1);
  return { dayOfWeek: local.getUTCDay(), hour: 19, minute: 0 };
}

beforeEach(async () => { fixture = await makeFixture(); });
afterEach(async () => {
  for (const clientId of clientIds.splice(0)) {
    await db.contentVersionAsset.deleteMany({ where: { clientId } });
    await db.productAsset.deleteMany({ where: { clientId } });
    await db.client.deleteMany({ where: { id: clientId } });
  }
  for (const userId of userIds.splice(0)) await db.user.deleteMany({ where: { id: userId } });
});
afterAll(async () => { await db.$disconnect(); });

describe("asset library", () => {
  it("searches and filters tenant assets with scoped tags", async () => {
    const asset = await makeAsset(fixture, "primary", { width: 1200, height: 630 });
    const tags = await setAssetTags(fixture.context, asset.id, { tags: ["Product", "Launch"] });
    const results = await searchAssets(fixture.context, { query: "chair", tagIds: [tags[0].id], kind: "IMAGE" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: asset.id, width: 1200, height: 630, availability: "LOCAL_ONLY" });
    const other = await makeFixture();
    await expect(setAssetTags(other.context, asset.id, { tags: ["Forbidden"] })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(await searchAssets(other.context, { query: "chair" })).toHaveLength(0);
  });

  it("detects duplicate fingerprints without deleting the existing asset", async () => {
    const asset = await makeAsset(fixture, "duplicate");
    const result = await detectDuplicateAsset(fixture.context, asset.checksum);
    expect(result).toMatchObject({ duplicate: true, asset: { id: asset.id } });
    expect(await db.asset.count({ where: { id: asset.id } })).toBe(1);
  });

  it("derives product, content, platform and recent usage from real relations", async () => {
    const asset = await makeAsset();
    const item = await createItem(fixture, false);
    await db.productAsset.create({ data: { clientId: fixture.client.id, productId: fixture.productId, assetId: asset.id } });
    await db.contentVersionAsset.create({ data: { clientId: fixture.client.id, contentVersionId: item.currentVersionId!, assetId: asset.id } });
    const usage = await getAssetUsage(fixture.context, asset.id);
    expect(usage.linkedProducts).toEqual([{ id: fixture.productId, name: "Test product" }]);
    expect(usage.usageCount).toBe(1);
    expect(usage.platformUsage).toEqual([{ platform: "facebook", count: 1 }]);
  });

  it("classifies local, private, public, signed and unavailable media", () => {
    expect(classifyMediaAvailability({ storageProvider: "local", storageKey: "x", metadata: null })).toBe("LOCAL_ONLY");
    expect(classifyMediaAvailability({ storageProvider: "s3", storageKey: "x", metadata: {} })).toBe("PRIVATE_REMOTE");
    expect(classifyMediaAvailability({ storageProvider: "s3", storageKey: "x", metadata: { publicUrl: "https://cdn.example/x" } })).toBe("PUBLIC_HTTPS");
    expect(classifyMediaAvailability({ storageProvider: "s3", storageKey: "x", metadata: { signedUrl: "https://signed.example/x" } })).toBe("SIGNED_HTTPS");
    expect(classifyMediaAvailability({ storageProvider: "s3", storageKey: "", metadata: null })).toBe("UNAVAILABLE");
  });
});

describe("calendar queues", () => {
  it("calculates bounded recurring slots in the client timezone", async () => {
    const after = new Date(Date.now() + 60_000);
    const queue = await upsertScheduleQueue(fixture.context, null, { accountId: fixture.account.id, name: "Evening", timezone: "Asia/Shanghai", horizonDays: 14, slots: [nextLocalSlot(after)] });
    const occurrences = await getQueueOccurrences(fixture.context, queue.id, after);
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
    expect(occurrences.every((date) => date.getTime() > after.getTime())).toBe(true);
    expect(occurrences[occurrences.length - 1].getTime() - after.getTime()).toBeLessThanOrEqual(15 * 24 * 60 * 60 * 1000);
  });

  it("detects account conflicts and assigns approved content through the existing scheduler", async () => {
    const after = new Date(Date.now() + 60_000);
    const slot = nextLocalSlot(after);
    const queue = await upsertScheduleQueue(fixture.context, null, { accountId: fixture.account.id, name: "Conflict-safe", timezone: "Asia/Shanghai", horizonDays: 14, slots: [slot] });
    const first = await createItem();
    const assignment = await assignContentToQueue(fixture.context, { queueId: queue.id, contentItemId: first.id, after });
    const conflict = await detectScheduleConflict(fixture.context, { accountId: fixture.account.id, scheduledAt: assignment.scheduledAt });
    expect(conflict.conflict).toBe(true);
    expect(conflict.conflicts.some((entry) => entry.id === first.id)).toBe(true);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: assignment.publishJobId } })).nextAttemptAt.toISOString()).toBe(assignment.scheduledAt.toISOString());
  });

  it("preserves approval and timezone requirements", async () => {
    const after = new Date(Date.now() + 60_000);
    const queue = await upsertScheduleQueue(fixture.context, null, { accountId: fixture.account.id, name: "Approval queue", timezone: "Asia/Shanghai", slots: [nextLocalSlot(after)] });
    const draft = await createItem(fixture, false);
    await expect(assignContentToQueue(fixture.context, { queueId: queue.id, contentItemId: draft.id, after })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(upsertScheduleQueue(fixture.context, null, { accountId: fixture.account.id, name: "Wrong zone", timezone: "UTC", slots: [nextLocalSlot(after)] })).rejects.toMatchObject({ code: "SCHEDULE_TIMEZONE_MISMATCH" });
  });

  it("returns explicit per-item bulk results and never mutates protected jobs", async () => {
    const mutable = await createItem();
    const protectedItem = await createItem();
    await db.contentItem.update({ where: { id: protectedItem.id }, data: { status: "PUBLISHED" } });
    const target = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const result = await bulkRescheduleWithResults(fixture.context, { operations: [
      { contentItemId: mutable.id, scheduledAt: target },
      { contentItemId: protectedItem.id, scheduledAt: target },
    ] });
    expect(result).toMatchObject({ updated: 1, rejected: 1 });
    expect(result.results.map((entry) => entry.status)).toEqual(["UPDATED", "REJECTED"]);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: protectedItem.id } })).scheduledAt).toBeNull();
  });
});
