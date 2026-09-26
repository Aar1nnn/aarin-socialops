import { randomUUID } from "node:crypto";
import type { Client, SocialAccount } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DraftGenerationInput,
  StructuredTextGenerationAdapter,
  StructuredTextGenerationInput,
  TextGenerationAdapter,
} from "../src/lib/adapters/types";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import {
  calculateBrandCompleteness,
  confirmBrandAutofill,
  createBrandAutofillDraft,
} from "../src/services/brand-autofill-service";
import { getBrandProfile, upsertBrandProfile } from "../src/services/brand-service";
import {
  compareContentVersions,
  regeneratePlatformVariant,
  restoreContentVersion,
  rewriteContent,
  updateDraftContent,
} from "../src/services/content-composition-service";
import { generateContentPlan, reviewContent, schedulePublication, submitForReview } from "../src/services/content-service";
import { getContentOperationsDetail, listContentOperations } from "../src/services/content-operations-view";
import { getContentTimeline, requestContentChanges } from "../src/services/approval-collaboration-service";

type Fixture = { client: Client; account: SocialAccount; context: RequestContext; productId: string };
const clientIds: string[] = [];
const userIds: string[] = [];
let fixture: Fixture;

async function makeFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `phase-a-${suffix}`, name: `Phase A ${suffix}`, mode: "DEMO" } });
  clientIds.push(client.id);
  const user = await db.user.create({ data: { email: `phase-a-${suffix}@example.local`, displayName: "Phase A", passwordHash: "unused" } });
  userIds.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: "OWNER" } });
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "Phase A Page", publishCapability: "VERIFIED" } });
  await db.platformPolicy.create({ data: { clientId: client.id, platform: "facebook", source: "test" } });
  await db.promptVersion.create({ data: { clientId: client.id, capability: "multi_platform_content", version: suffix, instruction: "Confirmed facts only.", schemaName: "GeneratedDrafts", modelConfig: {} } });
  const product = await db.product.create({
    data: {
      clientId: client.id,
      name: "Verified Chair",
      status: "CONFIRMED",
      fields: { create: [
        { clientId: client.id, key: "material", value: "verified steel", status: "CONFIRMED", source: "catalogue" },
        { clientId: client.id, key: "dimensions", value: "unconfirmed dimensions", status: "PROPOSED", source: "draft" },
      ] },
    },
  });
  return { client, account, productId: product.id, context: { clientId: client.id, userId: user.id, role: "OWNER" } };
}

async function createItem(target = fixture) {
  const generated = await generateContentPlan(target.context, {
    productId: target.productId,
    theme: "Wholesale chair",
    objective: "Qualified enquiries",
    accountIds: [target.account.id],
    assetIds: [],
  });
  return generated.items[0];
}

async function enableRealTextModel(target = fixture) {
  return db.integrationConfig.create({
    data: {
      clientId: target.client.id,
      type: "TEXT_GENERATION",
      provider: "openai-compatible",
      status: "VERIFIED",
      verifiedAt: new Date(),
    },
  });
}

function adapter(captured: DraftGenerationInput[], text = "Rewritten verified steel chair."): TextGenerationAdapter {
  return {
    async generate(input) {
      captured.push(input);
      return {
        provider: "test-composition",
        model: "test",
        simulated: true,
        usage: { inputUnits: 1, outputUnits: 1 },
        output: { drafts: [{ platform: "facebook", title: "Variant", text, usedFactKeys: ["material"], missingInformation: ["dimensions"], isGenericMarketDraft: false }] },
      };
    },
  };
}

beforeEach(async () => { fixture = await makeFixture(); });
afterEach(async () => {
  for (const clientId of clientIds.splice(0)) await db.client.deleteMany({ where: { id: clientId } });
  for (const userId of userIds.splice(0)) await db.user.deleteMany({ where: { id: userId } });
});
afterAll(async () => { await db.$disconnect(); });

describe("content composition engine", () => {
  it("regenerates only the target platform with confirmed facts and never creates approval or publish jobs", async () => {
    const instagram = await db.socialAccount.create({ data: { clientId: fixture.client.id, platform: "instagram", displayName: "Sibling Instagram", publishCapability: "VERIFIED" } });
    await db.platformPolicy.create({ data: { clientId: fixture.client.id, platform: "instagram", source: "test" } });
    const generated = await generateContentPlan(fixture.context, {
      productId: fixture.productId,
      theme: "Two-platform composition",
      objective: "Qualified enquiries",
      accountIds: [fixture.account.id, instagram.id],
      assetIds: [],
    });
    const item = generated.items.find((candidate) => candidate.platform === "facebook")!;
    const sibling = generated.items.find((candidate) => candidate.platform === "instagram")!;
    const captured: DraftGenerationInput[] = [];
    const result = await regeneratePlatformVariant(fixture.context, item.id, { expectedVersionId: item.currentVersionId }, adapter(captured));
    expect(result.version).toBe(2);
    expect(result.source).toBe("AI_REGENERATE");
    expect(captured[0].confirmedFacts).toEqual([{ key: "material", value: "verified steel", source: "catalogue" }]);
    expect(JSON.stringify(captured[0])).not.toContain("unconfirmed dimensions");
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: sibling.id } })).currentVersionId).toBe(sibling.currentVersionId);
    expect(await db.contentVersion.count({ where: { contentItemId: sibling.id } })).toBe(1);
    expect(await db.contentItem.count({ where: { clientId: fixture.client.id } })).toBe(2);
    expect(await db.approval.count({ where: { clientId: fixture.client.id } })).toBe(0);
    expect(await db.publishJob.count({ where: { clientId: fixture.client.id } })).toBe(0);
  });

  it("creates immutable rewrite, autosave and restore versions and detects stale concurrency", async () => {
    const item = await createItem();
    const rewritten = await rewriteContent(fixture.context, item.id, { expectedVersionId: item.currentVersionId, action: "shorten" }, adapter([], "Short steel chair."));
    const saved = await updateDraftContent(fixture.context, item.id, { expectedVersionId: rewritten.id, text: "Manual operator edit." });
    await expect(updateDraftContent(fixture.context, item.id, { expectedVersionId: rewritten.id, text: "Stale edit." })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const restored = await restoreContentVersion(fixture.context, item.id, { versionId: rewritten.id, expectedVersionId: saved.id });
    expect(restored.id).not.toBe(rewritten.id);
    expect(restored.version).toBe(4);
    expect(restored.text).toBe(rewritten.text);
    const comparison = await compareContentVersions(fixture.context, item.id, rewritten.id, saved.id);
    expect(comparison.changedFields).toContain("text");
    expect(await db.contentVersion.count({ where: { contentItemId: item.id } })).toBe(4);
  });

  it("keeps long current copy in model context without overflowing DEMO-generated titles", async () => {
    const item = await createItem();
    const long = await updateDraftContent(fixture.context, item.id, { expectedVersionId: item.currentVersionId, text: `Verified steel chair. ${"Buyer context. ".repeat(40)}` });
    const rewritten = await rewriteContent(fixture.context, item.id, { expectedVersionId: long.id, action: "rewrite" });
    expect(rewritten.version).toBe(long.version + 1);
    expect(rewritten.title?.length).toBeLessThanOrEqual(200);
    expect(rewritten.source).toBe("AI_REWRITE");
  });

  it("denies cross-tenant version access", async () => {
    const item = await createItem();
    const other = await makeFixture();
    await expect(updateDraftContent(other.context, item.id, { expectedVersionId: item.currentVersionId, text: "Cross tenant." })).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });

  it("rejects stale submit, human approval and scheduling without changing the newer version", async () => {
    const item = await createItem();
    const saved = await updateDraftContent(fixture.context, item.id, { expectedVersionId: item.currentVersionId, text: "Confirmed verified steel chair for wholesale." });
    await expect(submitForReview(fixture.context, item.id, item.currentVersionId!)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await submitForReview(fixture.context, item.id, saved.id);
    await expect(reviewContent(fixture.context, item.id, "APPROVED", "stale", item.currentVersionId!)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await db.approval.count({ where: { clientId: fixture.client.id } })).toBe(0);
    await reviewContent(fixture.context, item.id, "APPROVED", "current", saved.id);
    await expect(schedulePublication(fixture.context, item.id, { publishMode: "SCHEDULED", localDateTime: "2030-01-01T12:00", timezone: "Asia/Shanghai" }, item.currentVersionId!)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await db.publishJob.count({ where: { clientId: fixture.client.id } })).toBe(0);
    const job = await schedulePublication(fixture.context, item.id, { publishMode: "SCHEDULED", localDateTime: "2030-01-01T12:00", timezone: "Asia/Shanghai" }, saved.id);
    expect(job.contentVersionId).toBe(saved.id);
    const newer = await updateDraftContent(fixture.context, item.id, { expectedVersionId: saved.id, text: "A later version with verified steel." });
    expect(newer.version).toBe(saved.version + 1);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    await expect(schedulePublication(fixture.context, item.id, undefined, newer.id)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("limits content operations reads to the selected client and writes to non-viewers", async () => {
    const item = await createItem();
    const other = await makeFixture();
    expect((await listContentOperations(fixture.context, { q: "Wholesale chair" })).items.some((entry) => entry.id === item.id)).toBe(true);
    await db.socialAccount.update({ where: { id: fixture.account.id }, data: { isSelected: false } });
    const historical = await listContentOperations(fixture.context, { accountId: fixture.account.id });
    expect(historical.items.some((entry) => entry.id === item.id)).toBe(true);
    expect(historical.filterAccounts.some((account) => account.id === fixture.account.id)).toBe(true);
    expect(historical.accounts.some((account) => account.id === fixture.account.id)).toBe(false);
    expect((await listContentOperations(other.context, { q: "Wholesale chair" })).items.some((entry) => entry.id === item.id)).toBe(false);
    expect(await getContentOperationsDetail(other.context, item.id)).toBeNull();
    const viewer = { ...fixture.context, role: "VIEWER" as const };
    await expect(updateDraftContent(viewer, item.id, { expectedVersionId: item.currentVersionId, text: "Viewer edit" })).rejects.toMatchObject({ status: 403 });
    await expect(submitForReview(viewer, item.id, item.currentVersionId!)).rejects.toMatchObject({ status: 403 });
  });
});

describe("brand autofill", () => {
  it("returns an explicit rule-based degraded result without persisting or recording model usage", async () => {
    const draft = await createBrandAutofillDraft(fixture.context, { companyDescription: "Wholesale furniture exporter", structured: { audience: "Distributors", goals: ["Leads"] } });
    expect(draft.status).toBe("SUGGESTED");
    expect(draft.persistence).toBe("TRANSIENT");
    expect(draft).toMatchObject({ analysisMode: "RULE_BASED", provider: "rules", model: null, degraded: true });
    expect(draft.degradationReason).toContain("未调用 AI 模型");
    expect(draft.suggestions.audience).toEqual({ status: "SUGGESTED", value: "Distributors" });
    expect(calculateBrandCompleteness({ audience: "Distributors", goals: ["Leads"] })).toMatchObject({ completedFields: ["audience", "goals"] });
    expect((await getBrandProfile(fixture.context)).source).toBe("LEGACY_FALLBACK");
    expect(await db.usageReservation.count({ where: { clientId: fixture.client.id } })).toBe(0);
    expect(await db.usageLog.count({ where: { clientId: fixture.client.id } })).toBe(0);
  });

  it("calls the configured structured model adapter, settles usage, and keeps suggestions transient", async () => {
    await enableRealTextModel();
    const captured: StructuredTextGenerationInput[] = [];
    const modelAdapter: StructuredTextGenerationAdapter = {
      async generateStructured(input) {
        captured.push(input);
        return {
          output: { businessSummary: "Model summary", audience: "Wholesale distributors", goals: ["Qualified leads"] },
          provider: "openai-compatible",
          model: "brand-test-model",
          simulated: false,
          usage: { inputUnits: 17, outputUnits: 9 },
        };
      },
    };

    const draft = await createBrandAutofillDraft(fixture.context, { companyDescription: "Verified source text" }, modelAdapter);

    expect(captured).toHaveLength(1);
    expect(captured[0].input).toEqual({ companyDescription: "Verified source text" });
    expect(captured[0].schemaDescription).toContain("businessSummary");
    expect(draft).toMatchObject({ analysisMode: "MODEL", provider: "openai-compatible", model: "brand-test-model", degraded: false, persistence: "TRANSIENT" });
    expect(draft.suggestions.audience).toEqual({ status: "SUGGESTED", value: "Wholesale distributors" });
    expect((await getBrandProfile(fixture.context)).source).toBe("LEGACY_FALLBACK");
    expect(await db.usageReservation.findFirst({ where: { clientId: fixture.client.id } })).toMatchObject({ status: "SETTLED", settledUnits: 26, capability: "brand_autofill" });
    expect(await db.usageLog.findFirst({ where: { clientId: fixture.client.id } })).toMatchObject({ capability: "brand_autofill", provider: "openai-compatible", model: "brand-test-model", inputUnits: 17, outputUnits: 9, simulated: false });
  });

  it("releases reserved usage when the model output violates the brand schema", async () => {
    await enableRealTextModel();
    const modelAdapter: StructuredTextGenerationAdapter = {
      async generateStructured() {
        return { output: { unknown: "field" }, provider: "openai-compatible", model: "brand-test-model", simulated: false, usage: { inputUnits: 3, outputUnits: 2 } };
      },
    };

    await expect(createBrandAutofillDraft(fixture.context, { manualNotes: "notes" }, modelAdapter)).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
    expect(await db.usageReservation.findFirst({ where: { clientId: fixture.client.id } })).toMatchObject({ status: "RELEASED", settledUnits: 0 });
    expect(await db.usageLog.count({ where: { clientId: fixture.client.id } })).toBe(0);
    expect((await getBrandProfile(fixture.context)).source).toBe("LEGACY_FALLBACK");
  });

  it("releases reserved usage and does not fall back when a verified model call fails", async () => {
    await enableRealTextModel();
    const modelAdapter: StructuredTextGenerationAdapter = {
      async generateStructured() {
        throw new Error("provider unavailable");
      },
    };

    await expect(createBrandAutofillDraft(fixture.context, { manualNotes: "notes" }, modelAdapter)).rejects.toThrow("provider unavailable");
    expect(await db.usageReservation.findFirst({ where: { clientId: fixture.client.id } })).toMatchObject({ status: "RELEASED", settledUnits: 0 });
    expect(await db.usageLog.count({ where: { clientId: fixture.client.id } })).toBe(0);
  });

  it("blocks the configured model before invocation when the tenant budget is exhausted", async () => {
    await enableRealTextModel();
    await db.client.update({ where: { id: fixture.client.id }, data: { usageMonthlyLimit: 0 } });
    const generateStructured = vi.fn<StructuredTextGenerationAdapter["generateStructured"]>();

    await expect(createBrandAutofillDraft(fixture.context, { manualNotes: "notes" }, { generateStructured })).rejects.toMatchObject({ code: "USAGE_LIMIT_EXCEEDED" });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(await db.usageReservation.count({ where: { clientId: fixture.client.id } })).toBe(0);
    expect(await db.manualTask.count({ where: { clientId: fixture.client.id, triggerReason: "文本模型月度使用量上限已触达" } })).toBe(1);
  });

  it("rejects empty source material and accepted fields without a suggestion or override", async () => {
    await expect(createBrandAutofillDraft(fixture.context, { structured: {} })).rejects.toThrow();
    await expect(confirmBrandAutofill(fixture.context, { suggestions: {}, acceptedFields: ["tone"] })).rejects.toMatchObject({ code: "BRAND_FIELD_VALUE_REQUIRED" });
    expect((await getBrandProfile(fixture.context)).source).toBe("LEGACY_FALLBACK");
  });

  it("only writes confirmed fields with human overrides", async () => {
    const confirmed = await confirmBrandAutofill(fixture.context, {
      suggestions: { audience: "Draft audience", tone: "Draft tone", goals: ["Leads"] },
      acceptedFields: ["audience", "goals"],
      overrides: { audience: "Confirmed audience" },
    });
    expect(confirmed.profile.audience).toBe("Confirmed audience");
    expect(confirmed.profile.tone).toBeNull();
    expect(confirmed.profile.goals).toEqual(["Leads"]);
  });

  it("serializes concurrent reviewers accepting different brand fields", async () => {
    const reviewer = await db.user.create({ data: { email: `phase-a-reviewer-${randomUUID()}@example.local`, displayName: "Phase A Reviewer", passwordHash: "unused" } });
    userIds.push(reviewer.id);
    await db.clientMembership.create({ data: { clientId: fixture.client.id, userId: reviewer.id, role: "OPERATOR" } });
    const reviewerContext: RequestContext = { clientId: fixture.client.id, userId: reviewer.id, role: "OPERATOR" };

    await Promise.all([
      confirmBrandAutofill(fixture.context, {
        suggestions: { audience: "Wholesale distributors" },
        acceptedFields: ["audience"],
      }),
      confirmBrandAutofill(reviewerContext, {
        suggestions: { tone: "Practical and precise" },
        acceptedFields: ["tone"],
      }),
    ]);

    expect(await getBrandProfile(fixture.context)).toMatchObject({
      audience: "Wholesale distributors",
      tone: "Practical and precise",
    });
    expect(await db.auditLog.count({ where: { clientId: fixture.client.id, action: "BRAND_PROFILE_UPDATED" } })).toBe(2);
  });

  it("uses the same tenant lock for autofill confirmation and manual brand updates", async () => {
    await Promise.all([
      confirmBrandAutofill(fixture.context, {
        suggestions: { audience: "Confirmed distributor audience" },
        acceptedFields: ["audience"],
      }),
      upsertBrandProfile(fixture.context, { tone: "Manually saved tone" }),
    ]);

    expect(await getBrandProfile(fixture.context)).toMatchObject({
      audience: "Confirmed distributor audience",
      tone: "Manually saved tone",
    });
  });

  it("keeps confirmation tenant scoped", async () => {
    const other = await makeFixture();
    await confirmBrandAutofill(fixture.context, { suggestions: { tone: "Tenant A" }, acceptedFields: ["tone"] });
    expect((await getBrandProfile(other.context)).tone).not.toBe("Tenant A");
  });
});

describe("approval collaboration", () => {
  it("records requested changes, creates a new revision, invalidates old approval and supports reapproval", async () => {
    const item = await createItem();
    await submitForReview(fixture.context, item.id);
    const requested = await requestContentChanges(fixture.context, item.id, {
      expectedVersionId: item.currentVersionId,
      comment: "Use a clearer CTA.",
      reason: "CTA",
      requestedChanges: [{ field: "text", instruction: "Change CTA" }],
    });
    expect(requested.status).toBe("CHANGES_REQUESTED");
    const revised = await updateDraftContent(fixture.context, item.id, { expectedVersionId: item.currentVersionId, text: "Revised CTA." });
    expect(revised.previousVersionId).toBe(item.currentVersionId);
    await submitForReview(fixture.context, item.id);
    await reviewContent(fixture.context, item.id, "APPROVED", "Approved revision");
    const approvals = await db.approval.findMany({ where: { clientId: fixture.client.id }, orderBy: { createdAt: "asc" } });
    expect(approvals.map((approval) => approval.decision)).toEqual(["REJECTED", "APPROVED"]);
    expect(approvals[0].contentVersionId).not.toBe(approvals[1].contentVersionId);
  });

  it("keeps review comments tenant scoped and returns an ordered timeline", async () => {
    const item = await createItem();
    await submitForReview(fixture.context, item.id);
    await requestContentChanges(fixture.context, item.id, { expectedVersionId: item.currentVersionId, comment: "Revise", requestedChanges: [{ instruction: "Shorten" }] });
    const timeline = await getContentTimeline(fixture.context, item.id);
    expect(timeline.some((event) => event.type === "REVIEW_COMMENT_CREATED")).toBe(true);
    expect(timeline.every((event, index) => index === 0 || event.occurredAt.getTime() >= timeline[index - 1].occurredAt.getTime())).toBe(true);
    const other = await makeFixture();
    await expect(getContentTimeline(other.context, item.id)).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });
});
