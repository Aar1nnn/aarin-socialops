import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MockTextGenerationAdapter } from "../src/lib/adapters/text-generation";
import { calendarDateKey, calendarGrid, moveCalendarDatePreservingClock } from "../src/lib/calendar-display";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import { manualAccountProfileUrl, resolveAccountPublishingMode } from "../src/lib/manual-account";
import { zonedLocalDateTimeToUtc } from "../src/lib/timezone";
import { listCalendarEntries, rescheduleCalendarItems } from "../src/services/calendar-service";
import { regeneratePlatformVariant, rewriteContent } from "../src/services/content-composition-service";
import { editContentVersion, reviewContent, schedulePublication, submitForReview } from "../src/services/content-service";
import { createManualAccount } from "../src/services/manual-account-service";
import { createManualContent } from "../src/services/manual-content-service";
import { recordManualPublishResult } from "../src/services/manual-publish-service";
import { queryPlatformPublish } from "../src/services/platform-publish-query-service";
import { reconcileUnknownPublish } from "../src/services/publish-worker-service";
import { claimPublishJob } from "../src/services/publish-worker-service";
import { confirmSocialStrategy, createSocialStrategyDraft } from "../src/services/social-strategy-service";

const clientIds: string[] = [];
const userIds: string[] = [];
const mock = new MockTextGenerationAdapter();

async function fixture(timezone = "Asia/Shanghai") {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `m1-${suffix}`, name: "M1 Test", mode: "LIVE", timezone, targetMarkets: ["US"] } });
  clientIds.push(client.id);
  const roles = {} as Record<"OWNER" | "OPERATOR" | "VIEWER", RequestContext>;
  for (const role of ["OWNER", "OPERATOR", "VIEWER"] as const) {
    const user = await db.user.create({ data: { email: `m1-${role.toLowerCase()}-${suffix}@example.local`, displayName: role, passwordHash: "unused" } });
    userIds.push(user.id);
    await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role } });
    roles[role] = { clientId: client.id, userId: user.id, role };
  }
  const prompt = await db.promptVersion.create({ data: { clientId: client.id, capability: "multi_platform_content", version: suffix, instruction: "Confirmed facts only", schemaName: "GeneratedDrafts", modelConfig: {} } });
  const product = await db.product.create({ data: { clientId: client.id, name: "Verified chair", status: "CONFIRMED", fields: { create: [{ clientId: client.id, key: "material", value: "verified steel", status: "CONFIRMED", source: "catalogue" }] } } });
  return { client, roles, product, prompt, suffix };
}

async function account(f: Awaited<ReturnType<typeof fixture>>, platform: "linkedin" | "tiktok" | "youtube" = "linkedin") {
  return createManualAccount(f.roles.OPERATOR, {
    platform,
    accountType: platform === "linkedin" ? "LINKEDIN_MEMBER" : platform === "tiktok" ? "TIKTOK_ACCOUNT" : "YOUTUBE_CHANNEL",
    displayName: `M1 ${platform}`,
    profileUrl: `https://example.test/${platform}/${randomUUID()}`,
  });
}

async function approvedContent(f: Awaited<ReturnType<typeof fixture>>, accountId: string, productId?: string, assetIds: string[] = []) {
  const created = await createManualContent(f.roles.OPERATOR, {
    accountId, productId, assetIds,
    theme: `Manual post ${randomUUID()}`, objective: "Reach buyers",
    title: "Verified announcement", text: `Operator-authored copy ${randomUUID()}`,
  });
  await submitForReview(f.roles.OPERATOR, created.item.id, created.version.id);
  await reviewContent(f.roles.OWNER, created.item.id, "APPROVED", "Human checked", created.version.id);
  return created;
}

afterEach(async () => {
  for (const clientId of clientIds.splice(0)) {
    await db.contentVersionAsset.deleteMany({ where: { clientId } });
    await db.client.deleteMany({ where: { id: clientId } });
  }
  for (const userId of userIds.splice(0)) await db.user.deleteMany({ where: { id: userId } });
});
afterAll(async () => { await db.$disconnect(); });

describe("M1 manual publishing", () => {
  it("creates truthful manual accounts, enforces roles and serializes duplicate profiles", async () => {
    const f = await fixture();
    await expect(createManualAccount(f.roles.VIEWER, { platform: "linkedin", accountType: "LINKEDIN_MEMBER", displayName: "Denied", profileUrl: "https://example.test/denied" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const profileUrl = `https://example.test/company/${f.suffix}`;
    const results = await Promise.allSettled([
      createManualAccount(f.roles.OWNER, { platform: "linkedin", accountType: "LINKEDIN_ORGANIZATION", displayName: "First", profileUrl }),
      createManualAccount(f.roles.OPERATOR, { platform: "linkedin", accountType: "LINKEDIN_ORGANIZATION", displayName: "Second", profileUrl }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual(["MANUAL_ACCOUNT_EXISTS"]);
    const created = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof createManualAccount>>>).value;
    expect(resolveAccountPublishingMode(created)).toBe("MANUAL");
    expect(manualAccountProfileUrl(created)).toBe(new URL(profileUrl).toString());
    expect(created).toMatchObject({ publishCapability: "UNSUPPORTED", platformConnectionId: null, accessTokenCiphertext: null });
    await expect(createManualContent(f.roles.VIEWER, { accountId: created.id, theme: "x", objective: "y", text: "z" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await fixture();
    await expect(createManualContent(other.roles.OWNER, { accountId: created.id, theme: "x", objective: "y", text: "z" })).rejects.toMatchObject({ code: "MANUAL_ACCOUNT_REQUIRED" });
  });

  it("allows unbound human content, binds current confirmed strategy when present, and records actual AI prompt", async () => {
    const f = await fixture();
    const target = await account(f);
    const formCreated = await createManualContent(f.roles.OPERATOR, { accountId: target.id, productId: "", theme: "From form", objective: "Leads", text: "Human copy" });
    expect(formCreated.plan.productId).toBeNull();
    const unbound = await createManualContent(f.roles.OPERATOR, { accountId: target.id, productId: f.product.id, theme: "Unbound", objective: "Leads", text: "Verified steel chair" });
    expect(unbound.plan.socialStrategyId).toBeNull();
    expect(unbound.version.promptVersionId).toBeNull();
    expect(unbound.version.sourceFacts).toMatchObject({ strategyProvenance: "UNBOUND_FALLBACK", socialStrategyId: null, creationMethod: "MANUAL" });
    await expect(rewriteContent(f.roles.OPERATOR, unbound.item.id, { expectedVersionId: unbound.version.id, action: "shorten" }, mock)).rejects.toMatchObject({ code: "STRATEGY_BINDING_REQUIRED" });
    const payload = {
      businessGoal: "Qualified buyer enquiries", primaryBuyer: "Furniture distributors", targetMarkets: ["CA"],
      platformRoles: [{ platform: "linkedin", role: "Buyer outreach" }],
      contentPillars: [{ name: "Product facts", percentage: 100 }], formatMix: [{ name: "Text", percentage: 100 }],
      postingCadence: "Weekly", coreMessage: "Verified steel", ctaGuidance: ["Request catalogue"],
      priorityProducts: [], assetPriorities: [], experiments: [], limitations: [],
    };
    const draft = await createSocialStrategyDraft(f.roles.OWNER, { payload });
    await confirmSocialStrategy(f.roles.OWNER, draft.id);
    const bound = await createManualContent(f.roles.OPERATOR, { accountId: target.id, productId: f.product.id, theme: "Bound", objective: "Leads", text: "Verified steel chair for buyers" });
    expect(bound.plan.socialStrategyId).toBe(draft.id);
    expect(bound.plan.marketScope).toBe("CA");
    expect(bound.version.promptVersionId).toBeNull();
    expect(bound.version.sourceFacts).toMatchObject({ strategyProvenance: "CONFIRMED_BINDING", socialStrategyId: draft.id, socialStrategyVersion: 1, socialStrategyStatus: "CONFIRMED" });
    const rewritten = await rewriteContent(f.roles.OPERATOR, bound.item.id, { expectedVersionId: bound.version.id, action: "shorten" }, mock);
    expect(rewritten.promptVersionId).toBe(f.prompt.id);
    expect(rewritten.sourceFacts).toMatchObject({ creationMethod: "AI_COMPOSITION", socialStrategyId: draft.id });
    const regenerated = await regeneratePlatformVariant(f.roles.OPERATOR, bound.item.id, { expectedVersionId: rewritten.id }, mock);
    expect(regenerated.promptVersionId).toBe(f.prompt.id);
    expect(regenerated.sourceFacts).toMatchObject({ creationMethod: "AI_COMPOSITION", socialStrategyId: draft.id });
    expect((await db.contentVersion.findUniqueOrThrow({ where: { id: bound.version.id } })).promptVersionId).toBeNull();
  });

  it("requires approval, excludes manual jobs from worker claim, and safely records a published result", async () => {
    const f = await fixture();
    const target = await account(f);
    const item = await createManualContent(f.roles.OPERATOR, { accountId: target.id, theme: "Manual", objective: "Leads", text: "Human-written text" });
    await expect(schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await submitForReview(f.roles.OPERATOR, item.item.id, item.version.id);
    await reviewContent(f.roles.OWNER, item.item.id, "APPROVED", undefined, item.version.id);
    const job = await schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000));
    expect(job).toMatchObject({ status: "MANUAL_PENDING", adapter: "manual", environment: "LIVE", simulated: false, attemptCount: 0 });
    expect((await schedulePublication(f.roles.OWNER, item.item.id)).id).toBe(job.id);
    await db.publishJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
    expect(await claimPublishJob(job.id, "must-not-claim-manual")).toBeNull();
    expect(await db.publishAttempt.count({ where: { publishJobId: job.id } })).toBe(0);
    const submitted = { expectedContentVersionId: item.version.id, expectedJobStatus: "MANUAL_PENDING", outcome: "PUBLISHED", publishedAt: new Date(Date.now() - 60_000).toISOString(), remotePostUrl: "https://www.linkedin.com/posts/verified-1", evidence: "Checked the public post in the target account." };
    await expect(recordManualPublishResult(f.roles.VIEWER, job.id, submitted)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const published = await recordManualPublishResult(f.roles.OPERATOR, job.id, submitted);
    expect(published.status).toBe("PUBLISHED");
    expect((await recordManualPublishResult(f.roles.OPERATOR, job.id, submitted)).id).toBe(job.id);
    await expect(recordManualPublishResult(f.roles.OPERATOR, job.id, { ...submitted, outcome: "FAILED", confirmedNoExternalPost: true, remotePostUrl: undefined, publishedAt: undefined })).rejects.toMatchObject({ code: "MANUAL_RESULT_CONFLICT" });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: item.item.id } })).status).toBe("PUBLISHED");
    expect(await db.manualTask.count({ where: { clientId: f.client.id, publishJobId: job.id, status: "COMPLETED" } })).toBe(1);
    expect(await db.auditLog.findFirst({ where: { clientId: f.client.id, userId: f.roles.OPERATOR.userId, action: "MANUAL_PUBLISH_RESULT_RECORDED", entityId: job.id } })).toMatchObject({ metadata: { outcome: "PUBLISHED", evidence: submitted.evidence } });
  });

  it("distinguishes confirmed no-post failure from uncertainty and permits evidence-based reconciliation only", async () => {
    const f = await fixture();
    const target = await account(f);
    const item = await approvedContent(f, target.id);
    const job = await schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000));
    await expect(recordManualPublishResult(f.roles.OPERATOR, job.id, { expectedContentVersionId: item.version.id, expectedJobStatus: "MANUAL_PENDING", outcome: "FAILED", evidence: "Could not verify outcome." })).rejects.toThrow();
    const unknown = { expectedContentVersionId: item.version.id, expectedJobStatus: "MANUAL_PENDING", outcome: "UNKNOWN", evidence: "Platform confirmation timed out; external result uncertain." };
    expect((await recordManualPublishResult(f.roles.OPERATOR, job.id, unknown)).status).toBe("UNKNOWN");
    await expect(reconcileUnknownPublish(f.roles.OWNER, job.id, { outcome: "PUBLISHED", remotePostId: "fake", note: "wrong route" })).rejects.toMatchObject({ code: "MANUAL_RECONCILIATION_REQUIRED" });
    await expect(queryPlatformPublish(f.roles.OWNER, job.id)).rejects.toMatchObject({ code: "MANUAL_QUERY_UNSUPPORTED" });
    expect((await recordManualPublishResult(f.roles.OPERATOR, job.id, unknown)).status).toBe("UNKNOWN");
    expect(await claimPublishJob(job.id, "unknown-must-not-retry")).toBeNull();
    expect((await db.manualTask.findFirstOrThrow({ where: { publishJobId: job.id, status: "WAITING_EXTERNAL" } })).completedAt).toBeNull();
    const confirmed = { expectedContentVersionId: item.version.id, expectedJobStatus: "UNKNOWN", outcome: "FAILED", evidence: "Checked target account and drafts; no external post exists.", confirmedNoExternalPost: true };
    expect((await recordManualPublishResult(f.roles.OWNER, job.id, confirmed)).status).toBe("FAILED");
    expect((await recordManualPublishResult(f.roles.OWNER, job.id, confirmed)).status).toBe("FAILED");
    await expect(recordManualPublishResult(f.roles.OWNER, job.id, { ...confirmed, evidence: "Different assertion" })).rejects.toMatchObject({ code: "MANUAL_RESULT_CONFLICT" });
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).attemptCount).toBe(0);
  });

  it("cancels pending manual tasks when content changes and rejects stale result submissions", async () => {
    const f = await fixture();
    const target = await account(f);
    const item = await approvedContent(f, target.id);
    const job = await schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000));
    await editContentVersion(f.roles.OPERATOR, item.item.id, { expectedVersionId: item.version.id, text: "Human changed the copy." });
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    expect(await db.manualTask.count({ where: { publishJobId: job.id, status: "CANCELLED" } })).toBe(1);
    await expect(recordManualPublishResult(f.roles.OPERATOR, job.id, { expectedContentVersionId: item.version.id, expectedJobStatus: "MANUAL_PENDING", outcome: "UNKNOWN", evidence: "Stale operator" })).rejects.toMatchObject({ code: "MANUAL_RESULT_CONFLICT" });
  });

  it("cancels pending manual tasks when approval is reopened", async () => {
    const f = await fixture();
    const target = await account(f);
    const item = await approvedContent(f, target.id);
    const job = await schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000));
    await submitForReview(f.roles.OPERATOR, item.item.id, item.version.id);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    expect(await db.manualTask.count({ where: { publishJobId: job.id, status: "CANCELLED" } })).toBe(1);
  });

  it("requires a scoped operator for manual result recording", async () => {
    const f = await fixture();
    const target = await account(f);
    const item = await approvedContent(f, target.id);
    const job = await schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000));
    const other = await fixture();
    await expect(recordManualPublishResult(other.roles.OWNER, job.id, {
      expectedContentVersionId: item.version.id, expectedJobStatus: "MANUAL_PENDING", outcome: "UNKNOWN", evidence: "Other tenant",
    })).rejects.toMatchObject({ code: "PUBLISH_JOB_NOT_FOUND" });
  });

  it("completes TikTok and YouTube with existing video assets and no API attempts", async () => {
    const f = await fixture();
    for (const platform of ["tiktok", "youtube"] as const) {
      const target = await account(f, platform);
      const suffix = randomUUID();
      const video = await db.asset.create({
        data: { clientId: f.client.id, kind: "VIDEO", originalName: `${platform}-${suffix}.mp4`, mimeType: "video/mp4", byteSize: 1024, storageProvider: "local", storageKey: `m1/${suffix}`, checksum: `m1-${suffix}`, metadata: {} },
      });
      const item = await approvedContent(f, target.id, undefined, [video.id]);
      const job = await schedulePublication(f.roles.OPERATOR, item.item.id, new Date(Date.now() + 86_400_000));
      const published = await recordManualPublishResult(f.roles.OPERATOR, job.id, {
        expectedContentVersionId: item.version.id,
        expectedJobStatus: "MANUAL_PENDING",
        outcome: "PUBLISHED",
        publishedAt: new Date(Date.now() - 60_000).toISOString(),
        remotePostUrl: platform === "tiktok" ? "https://www.tiktok.com/@m1/video/123" : "https://www.youtube.com/watch?v=m1test",
        evidence: "Verified the public post on the selected account.",
      });
      expect(published).toMatchObject({ adapter: "manual", status: "PUBLISHED", remotePostId: null, attemptCount: 0 });
      expect(await db.publishAttempt.count({ where: { publishJobId: job.id } })).toBe(0);
    }
  });

  it("serializes schedule conflicts and keeps the manual task due time in sync with Calendar", async () => {
    const f = await fixture();
    const target = await account(f);
    const first = await approvedContent(f, target.id);
    const second = await approvedContent(f, target.id);
    const instant = new Date("2030-01-02T02:15:00Z");
    const attempts = await Promise.allSettled([
      schedulePublication(f.roles.OPERATOR, first.item.id, instant),
      schedulePublication(f.roles.OWNER, second.item.id, instant),
    ]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === "rejected").map((entry) => entry.reason.code)).toEqual(["SCHEDULE_CONFLICT"]);
    const scheduled = attempts.find((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof schedulePublication>>>;
    const scheduledItemId = scheduled.value.contentVersionId === first.version.id ? first.item.id : second.item.id;
    const targetLocal = moveCalendarDatePreservingClock(instant, "2030-01-03", f.client.timezone);
    expect(targetLocal).toBe("2030-01-03T10:15");
    await rescheduleCalendarItems(f.roles.OPERATOR, { contentItemIds: [scheduledItemId], localDateTime: targetLocal, timezone: f.client.timezone });
    const moved = await db.publishJob.findUniqueOrThrow({ where: { id: scheduled.value.id } });
    expect(moved.nextAttemptAt.toISOString()).toBe("2030-01-03T02:15:00.000Z");
    expect((await db.manualTask.findFirstOrThrow({ where: { publishJobId: moved.id, status: "TODO" } })).suggestedDueAt?.toISOString()).toBe(moved.nextAttemptAt.toISOString());
    expect((await listCalendarEntries(f.roles.VIEWER, { view: "list" })).find((entry) => entry.id === scheduledItemId)).toMatchObject({ publishingMode: "MANUAL", publishJobStatus: "MANUAL_PENDING", reschedulable: true });
  });

  it("requires video for TikTok and YouTube and rejects ambiguous local reschedule time", async () => {
    const f = await fixture("America/New_York");
    for (const platform of ["tiktok", "youtube"] as const) {
      const target = await account(f, platform);
      const item = await approvedContent(f, target.id);
      await expect(schedulePublication(f.roles.OPERATOR, item.item.id, new Date("2027-01-02T17:00:00Z"))).rejects.toMatchObject({ code: "MANUAL_MEDIA_REQUIRED" });
    }
    const target = await account(f);
    const item = await approvedContent(f, target.id);
    await schedulePublication(f.roles.OPERATOR, item.item.id, new Date("2027-01-02T17:00:00Z"));
    await expect(rescheduleCalendarItems(f.roles.OPERATOR, { contentItemIds: [item.item.id], localDateTime: "2026-11-01T01:30", timezone: f.client.timezone })).rejects.toMatchObject({ code: "AMBIGUOUS_SCHEDULE_TIME" });
    await expect(rescheduleCalendarItems(f.roles.OPERATOR, { contentItemIds: [item.item.id], localDateTime: "2027-03-14T02:30", timezone: f.client.timezone })).rejects.toMatchObject({ code: "INVALID_SCHEDULE_TIME" });
  });
});

describe("M1 Calendar display", () => {
  it("shows six-week months and groups timestamps by client timezone", () => {
    expect(calendarGrid("month", "2026-08-15").dayCount).toBe(42);
    expect(calendarGrid("week", "2026-08-15").dayCount).toBe(7);
    expect(calendarDateKey("2026-09-26T16:30:00Z", "Asia/Shanghai")).toBe("2026-09-27");
    expect(moveCalendarDatePreservingClock("2026-09-26T16:30:00Z", "2026-09-29", "Asia/Shanghai")).toBe("2026-09-29T00:30");
    expect(zonedLocalDateTimeToUtc("2026-09-29T00:30", "Asia/Shanghai").toISOString()).toBe("2026-09-28T16:30:00.000Z");
  });
});
