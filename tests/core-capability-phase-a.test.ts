import { randomUUID } from "node:crypto";
import type { Client, SocialAccount } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftGenerationInput, TextGenerationAdapter } from "../src/lib/adapters/types";
import type { RequestContext } from "../src/lib/context";
import { db } from "../src/lib/db";
import {
  calculateBrandCompleteness,
  confirmBrandAutofill,
  createBrandAutofillDraft,
} from "../src/services/brand-autofill-service";
import { getBrandProfile } from "../src/services/brand-service";
import {
  compareContentVersions,
  regeneratePlatformVariant,
  restoreContentVersion,
  rewriteContent,
  updateDraftContent,
} from "../src/services/content-composition-service";
import { generateContentPlan, reviewContent, submitForReview } from "../src/services/content-service";
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
    const item = await createItem();
    const captured: DraftGenerationInput[] = [];
    const result = await regeneratePlatformVariant(fixture.context, item.id, { expectedVersionId: item.currentVersionId }, adapter(captured));
    expect(result.version).toBe(2);
    expect(result.source).toBe("AI_REGENERATE");
    expect(captured[0].confirmedFacts).toEqual([{ key: "material", value: "verified steel", source: "catalogue" }]);
    expect(JSON.stringify(captured[0])).not.toContain("unconfirmed dimensions");
    expect(await db.contentItem.count({ where: { clientId: fixture.client.id } })).toBe(1);
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

  it("denies cross-tenant version access", async () => {
    const item = await createItem();
    const other = await makeFixture();
    await expect(updateDraftContent(other.context, item.id, { expectedVersionId: item.currentVersionId, text: "Cross tenant." })).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });
});

describe("brand autofill", () => {
  it("returns validated transient partial suggestions and deterministic completeness", async () => {
    const draft = await createBrandAutofillDraft(fixture.context, { companyDescription: "Wholesale furniture exporter", structured: { audience: "Distributors", goals: ["Leads"] } });
    expect(draft.status).toBe("SUGGESTED");
    expect(draft.persistence).toBe("TRANSIENT");
    expect(draft.suggestions.audience).toEqual({ status: "SUGGESTED", value: "Distributors" });
    expect(calculateBrandCompleteness({ audience: "Distributors", goals: ["Leads"] })).toMatchObject({ completedFields: ["audience", "goals"] });
    expect((await getBrandProfile(fixture.context)).source).toBe("LEGACY_FALLBACK");
  });

  it("rejects invalid analyzer output and only writes confirmed fields with human overrides", async () => {
    await expect(createBrandAutofillDraft(fixture.context, { manualNotes: "notes" }, async () => ({ unknown: "field" }))).rejects.toThrow();
    const confirmed = await confirmBrandAutofill(fixture.context, {
      suggestions: { audience: "Draft audience", tone: "Draft tone", goals: ["Leads"] },
      acceptedFields: ["audience", "goals"],
      overrides: { audience: "Confirmed audience" },
    });
    expect(confirmed.profile.audience).toBe("Confirmed audience");
    expect(confirmed.profile.tone).toBeNull();
    expect(confirmed.profile.goals).toEqual(["Leads"]);
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
