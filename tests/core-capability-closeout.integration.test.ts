import { randomUUID } from "node:crypto";
import type { Client, SocialAccount } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockSocialPublishAdapter } from "../src/lib/adapters/publishing";
import type { TextGenerationAdapter } from "../src/lib/adapters/types";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import { queryAnalyticsMetrics, getContentPerformance } from "../src/services/analytics-service";
import { requestContentChanges } from "../src/services/approval-collaboration-service";
import { confirmBrandAutofill, createBrandAutofillDraft } from "../src/services/brand-autofill-service";
import { getBrandProfile } from "../src/services/brand-service";
import { rewriteContent, updateDraftContent } from "../src/services/content-composition-service";
import { generateContentPlan, reviewContent, submitForReview } from "../src/services/content-service";
import {
  createAndDispatchNotification,
  upsertNotificationRule,
} from "../src/services/notification-service";
import { createProduct, updateProductFacts } from "../src/services/product-service";
import { claimPublishJob, processPublishJob } from "../src/services/publish-worker-service";
import { assignContentToQueue, upsertScheduleQueue } from "../src/services/schedule-queue-service";

type Fixture = {
  client: Client;
  account: SocialAccount;
  context: RequestContext;
};

const clientIds: string[] = [];
const userIds: string[] = [];
let fixture: Fixture;

async function makeFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const client = await db.client.create({
    data: {
      slug: `closeout-${suffix}`,
      name: `Closeout ${suffix}`,
      mode: "DEMO",
      isDemo: true,
      configurationStatus: "TEST",
      timezone: "Asia/Shanghai",
    },
  });
  clientIds.push(client.id);
  const user = await db.user.create({
    data: {
      email: `closeout-${suffix}@example.local`,
      displayName: "Closeout operator",
      passwordHash: "unused",
    },
  });
  userIds.push(user.id);
  await db.clientMembership.create({
    data: { clientId: client.id, userId: user.id, role: "OWNER" },
  });
  const account = await db.socialAccount.create({
    data: {
      clientId: client.id,
      platform: "facebook",
      displayName: "Controlled DEMO Facebook",
      publishCapability: "VERIFIED",
      metricsCapability: "VERIFIED",
    },
  });
  await db.platformPolicy.create({
    data: { clientId: client.id, platform: "facebook", source: "controlled-demo" },
  });
  await db.promptVersion.create({
    data: {
      clientId: client.id,
      capability: "multi_platform_content",
      version: suffix,
      instruction: "Use confirmed product facts only.",
      schemaName: "GeneratedDrafts",
      modelConfig: {},
    },
  });
  return {
    client,
    account,
    context: { clientId: client.id, userId: user.id, role: "OWNER" },
  };
}

async function createConfirmedProduct(target = fixture) {
  const product = await createProduct(target.context, {
    name: "Closeout chair",
    fields: [
      { key: "material", value: "draft steel", status: "PROPOSED", source: "operator note" },
      { key: "dimensions", value: "unconfirmed dimensions", status: "PROPOSED", source: "draft" },
    ],
  });
  return updateProductFacts(target.context, product.id, {
    name: product.name,
    fields: [
      { key: "material", value: "confirmed recycled steel", status: "CONFIRMED", source: "customer specification" },
    ],
  });
}

async function generateItem(productId: string, target = fixture) {
  const generated = await generateContentPlan(target.context, {
    productId,
    theme: "Controlled SocialOps acceptance",
    objective: "Qualified enquiries",
    accountIds: [target.account.id],
    assetIds: [],
  });
  return generated.items[0];
}

async function approveItem(itemId: string, target = fixture) {
  await submitForReview(target.context, itemId);
  await reviewContent(target.context, itemId, "APPROVED", "Controlled DEMO approval");
  return db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
}

function futureWeeklySlot(after: Date) {
  const local = new Date(after.getTime() + 8 * 60 * 60 * 1000);
  local.setUTCDate(local.getUTCDate() + 1);
  return { dayOfWeek: local.getUTCDay(), hour: 19, minute: 0 };
}

async function createQueue(name: string, after: Date, target = fixture) {
  return upsertScheduleQueue(target.context, null, {
    accountId: target.account.id,
    name,
    timezone: "Asia/Shanghai",
    horizonDays: 21,
    slots: [futureWeeklySlot(after)],
  });
}

const rewriteAdapter: TextGenerationAdapter = {
  async generate(input) {
    return {
      provider: "controlled-demo",
      model: "deterministic-test",
      simulated: true,
      usage: { inputUnits: 1, outputUnits: 1 },
      output: {
        drafts: input.platforms.map((platform) => ({
          platform,
          title: "Closeout acceptance",
          text: "A concise confirmed recycled steel chair message with a clear enquiry CTA.",
          usedFactKeys: ["material"],
          missingInformation: input.missingFields,
          isGenericMarketDraft: false,
        })),
      },
    };
  },
};

beforeEach(async () => {
  fixture = await makeFixture();
});

afterEach(async () => {
  delete process.env.CLOSEOUT_WEBHOOK_ENDPOINT;
  for (const clientId of clientIds.splice(0)) {
    await db.client.deleteMany({ where: { id: clientId } });
  }
  for (const userId of userIds.splice(0)) {
    await db.user.deleteMany({ where: { id: userId } });
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe("PR #7 controlled cross-module acceptance", () => {
  it("carries confirmed facts through brand confirmation, immutable review, queue, DEMO publish and analytics", async () => {
    const product = await createConfirmedProduct();
    const productFields = await db.productField.findMany({
      where: { productId: product.id },
      orderBy: { key: "asc" },
    });
    expect(productFields.find((field) => field.key === "material")).toMatchObject({
      status: "CONFIRMED",
      value: "confirmed recycled steel",
      source: "customer specification",
    });
    expect(productFields.find((field) => field.key === "dimensions")?.status).toBe("PROPOSED");

    const brandDraft = await createBrandAutofillDraft(fixture.context, {
      companyDescription: "A wholesale furniture exporter serving international distributors.",
      structured: {
        audience: "Furniture distributors",
        tone: "Professional and direct",
        goals: ["Qualified enquiries"],
      },
    });
    expect(brandDraft).toMatchObject({
      status: "SUGGESTED",
      persistence: "TRANSIENT",
      analysisMode: "RULE_BASED",
      degraded: true,
    });
    expect(await db.brandProfile.count({ where: { clientId: fixture.client.id } })).toBe(0);
    const suggestedValues = Object.fromEntries(
      Object.entries(brandDraft.suggestions).map(([field, suggestion]) => [field, suggestion.value]),
    );
    await confirmBrandAutofill(fixture.context, {
      suggestions: suggestedValues,
      acceptedFields: ["businessSummary", "audience", "tone", "goals"],
      overrides: { tone: "Human-confirmed professional tone" },
    });
    expect(await getBrandProfile(fixture.context)).toMatchObject({
      audience: "Furniture distributors",
      tone: "Human-confirmed professional tone",
      goals: ["Qualified enquiries"],
    });

    const generated = await generateItem(product.id);
    const generatedVersion = await db.contentVersion.findUniqueOrThrow({ where: { id: generated.currentVersionId! } });
    expect(JSON.stringify(generatedVersion.sourceFacts)).toContain("confirmed recycled steel");
    expect(JSON.stringify(generatedVersion.sourceFacts)).not.toContain("unconfirmed dimensions");
    const rewritten = await rewriteContent(
      fixture.context,
      generated.id,
      { expectedVersionId: generated.currentVersionId, action: "shorten" },
      rewriteAdapter,
    );
    await submitForReview(fixture.context, generated.id);
    await requestContentChanges(fixture.context, generated.id, {
      expectedVersionId: rewritten.id,
      comment: "Use the operator-confirmed CTA.",
      reason: "CTA alignment",
      requestedChanges: [{ field: "text", instruction: "End with a wholesale enquiry CTA." }],
    });
    const revised = await updateDraftContent(fixture.context, generated.id, {
      expectedVersionId: rewritten.id,
      text: "Confirmed recycled steel chair. Contact us for wholesale specifications.",
      reason: "REQUESTED_CHANGES_APPLIED",
    });
    expect(revised.previousVersionId).toBe(rewritten.id);

    const after = new Date(Date.now() + 60_000);
    const queue = await createQueue("Controlled acceptance queue", after);
    await expect(assignContentToQueue(fixture.context, {
      queueId: queue.id,
      contentItemId: generated.id,
      after,
    })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

    const other = await makeFixture();
    await expect(rewriteContent(
      other.context,
      generated.id,
      { expectedVersionId: revised.id, action: "humanize" },
      rewriteAdapter,
    )).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });

    await approveItem(generated.id);
    const firstAssignment = await assignContentToQueue(fixture.context, {
      queueId: queue.id,
      contentItemId: generated.id,
      after,
    });
    const duplicateAssignment = await assignContentToQueue(fixture.context, {
      queueId: queue.id,
      contentItemId: generated.id,
      after: new Date(after.getTime() + 1_000),
    });
    expect(duplicateAssignment).toEqual(firstAssignment);
    expect(await db.publishJob.count({ where: { clientId: fixture.client.id, contentVersionId: revised.id } })).toBe(1);
    const approvals = await db.approval.findMany({
      where: { clientId: fixture.client.id },
      orderBy: { createdAt: "asc" },
    });
    expect(approvals.map((approval) => [approval.contentVersionId, approval.decision])).toEqual([
      [rewritten.id, "REJECTED"],
      [revised.id, "APPROVED"],
    ]);

    await db.publishJob.update({
      where: { id: firstAssignment.publishJobId },
      data: { nextAttemptAt: new Date(0) },
    });
    expect(await claimPublishJob(firstAssignment.publishJobId, "closeout-demo-worker")).not.toBeNull();
    const published = await processPublishJob(firstAssignment.publishJobId, new MockSocialPublishAdapter("published"));
    expect(published).toMatchObject({
      status: "PUBLISHED",
      simulated: true,
      environment: "SIMULATED",
      attemptCount: 1,
    });
    expect(published.remotePostId).toMatch(/^mock_/);

    await db.metricSnapshot.create({
      data: {
        clientId: fixture.client.id,
        accountId: fixture.account.id,
        metricKey: `views:${published.remotePostId}`,
        numericValue: 42,
        availability: "AVAILABLE",
        dataKind: "MOCK",
        fetchedAt: new Date(),
        source: "controlled-demo",
      },
    });
    const metrics = await queryAnalyticsMetrics(fixture.context, {
      contentItemId: generated.id,
      metric: "views",
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ availability: "AVAILABLE", dataKind: "MOCK" });
    expect(metrics[0].numericValue?.toString()).toBe("42");
    expect((await getContentPerformance(fixture.context, { contentItemId: generated.id }))[0]).toMatchObject({
      remotePostId: published.remotePostId,
      views: 42,
    });
  });

  it("serializes two queue assignments competing for the same account slot", async () => {
    const product = await createConfirmedProduct();
    const [firstItem, secondItem] = await Promise.all([
      generateItem(product.id),
      generateItem(product.id),
    ]);
    await Promise.all([approveItem(firstItem.id), approveItem(secondItem.id)]);
    const after = new Date(Date.now() + 60_000);
    const [firstQueue, secondQueue] = await Promise.all([
      createQueue("Concurrent closeout A", after),
      createQueue("Concurrent closeout B", after),
    ]);
    const [first, second] = await Promise.all([
      assignContentToQueue(fixture.context, { queueId: firstQueue.id, contentItemId: firstItem.id, after }),
      assignContentToQueue(fixture.context, { queueId: secondQueue.id, contentItemId: secondItem.id, after }),
    ]);
    expect(first.scheduledAt.toISOString()).not.toBe(second.scheduledAt.toISOString());
    expect(new Set((await db.publishJob.findMany({
      where: { id: { in: [first.publishJobId, second.publishJobId] } },
      select: { nextAttemptAt: true },
    })).map((job) => job.nextAttemptAt.toISOString())).size).toBe(2);
  });

  it("keeps POST_DISPATCH UNKNOWN manual, deduplicated and isolated from external delivery failure", async () => {
    process.env.CLOSEOUT_WEBHOOK_ENDPOINT = "https://notify.example.test/closeout";
    await db.notificationChannel.create({
      data: {
        clientId: fixture.client.id,
        type: "WEBHOOK",
        displayName: "Closeout webhook",
        credentialRef: "env:CLOSEOUT_WEBHOOK_ENDPOINT",
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
    await upsertNotificationRule(fixture.context, {
      eventType: "PUBLISH_UNKNOWN",
      severity: "URGENT",
      channelType: "WEBHOOK",
      cooldownMinutes: 60,
    });

    const product = await createConfirmedProduct();
    const item = await generateItem(product.id);
    await approveItem(item.id);
    const after = new Date(Date.now() + 60_000);
    const queue = await createQueue("Unknown safety queue", after);
    const assignment = await assignContentToQueue(fixture.context, {
      queueId: queue.id,
      contentItemId: item.id,
      after,
    });
    await db.publishJob.update({ where: { id: assignment.publishJobId }, data: { nextAttemptAt: new Date(0) } });
    expect(await claimPublishJob(assignment.publishJobId, "closeout-unknown-worker")).not.toBeNull();

    const failingTransport = vi.fn(async () => {
      throw new Error("controlled external notification outage");
    });
    const unknown = await processPublishJob(
      assignment.publishJobId,
      new MockSocialPublishAdapter("unknown"),
      failingTransport,
    );
    expect(unknown.status).toBe("UNKNOWN");
    expect(failingTransport).toHaveBeenCalledTimes(1);
    expect(await db.manualTask.count({
      where: { clientId: fixture.client.id, publishJobId: assignment.publishJobId, status: "TODO" },
    })).toBe(1);
    const notification = await db.inAppNotification.findFirstOrThrow({
      where: {
        clientId: fixture.client.id,
        eventType: "PUBLISH_UNKNOWN",
        relatedType: "PublishJob",
        relatedId: assignment.publishJobId,
      },
    });
    expect(await db.notificationDelivery.findMany({
      where: { notificationId: notification.id },
    })).toEqual([expect.objectContaining({ status: "FAILED", attemptCount: 1 })]);

    const duplicate = await createAndDispatchNotification(fixture.context, {
      eventType: "PUBLISH_UNKNOWN",
      title: "发布结果未知，需要人工对账",
      body: "重复检测到同一 UNKNOWN；仍禁止盲目重发。",
      relatedType: "PublishJob",
      relatedId: assignment.publishJobId,
      urgent: true,
      dedupeKey: `PUBLISH_UNKNOWN:PublishJob:${assignment.publishJobId}`,
    }, failingTransport);
    expect(duplicate.deduplicated).toBe(true);
    expect(failingTransport).toHaveBeenCalledTimes(1);
    expect(await db.notificationDelivery.count({ where: { notificationId: notification.id } })).toBe(1);
    expect((await db.inAppNotification.findUniqueOrThrow({ where: { id: notification.id } })).occurrenceCount).toBe(2);

    expect(await claimPublishJob(assignment.publishJobId, "must-not-retry-unknown")).toBeNull();
    const ignored = await processPublishJob(
      assignment.publishJobId,
      new MockSocialPublishAdapter("published"),
      failingTransport,
    );
    expect(ignored.status).toBe("UNKNOWN");
    expect(await db.publishAttempt.count({ where: { publishJobId: assignment.publishJobId } })).toBe(1);
    expect(await db.auditLog.findFirst({
      where: { clientId: fixture.client.id, action: "PUBLISH_UNKNOWN", entityId: assignment.publishJobId },
    })).not.toBeNull();
  });
});
