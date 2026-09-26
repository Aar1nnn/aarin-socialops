import { randomUUID } from "node:crypto";
import type { ClientMode } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { DraftGenerationInput, TextGenerationAdapter } from "../src/lib/adapters/types";
import { MockTextGenerationAdapter } from "../src/lib/adapters/text-generation";
import { db } from "../src/lib/db";
import type { RequestContext } from "../src/lib/context";
import { generateContentPlan, reviewContent, schedulePublication, submitForReview } from "../src/services/content-service";
import { regeneratePlatformVariant, rewriteContent, updateDraftContent } from "../src/services/content-composition-service";
import {
  confirmSocialStrategy, createSocialStrategyDraft, listSocialStrategies,
  readStrategyProvenance, type SocialStrategyPayload,
} from "../src/services/social-strategy-service";

const clientIds: string[] = [];
const userIds: string[] = [];
const mock = new MockTextGenerationAdapter();

function payload(overrides: Partial<SocialStrategyPayload> = {}): SocialStrategyPayload {
  return {
    businessGoal: "Qualified wholesale enquiries",
    primaryBuyer: "Furniture distributors",
    targetMarkets: ["US"],
    platformRoles: [{ platform: "facebook", role: "Distributor awareness" }],
    contentPillars: [{ name: "Confirmed product facts", percentage: 100 }],
    formatMix: [{ name: "Image", percentage: 100 }],
    postingCadence: "One post each week",
    coreMessage: "Verified wholesale chair information",
    ctaGuidance: ["Invite a catalogue request"],
    priorityProducts: [], assetPriorities: [], experiments: [], limitations: [],
    ...overrides,
  };
}

async function fixture(mode: ClientMode = "DEMO") {
  const suffix = randomUUID();
  const client = await db.client.create({ data: { slug: `strategy-${suffix}`, name: "Strategy Test", mode, targetMarkets: ["Canada"] } });
  clientIds.push(client.id);
  const users = await Promise.all(["OWNER", "OPERATOR", "VIEWER"].map(async (role) => {
    const user = await db.user.create({ data: { email: `${role.toLowerCase()}-${suffix}@example.local`, displayName: role, passwordHash: "unused" } });
    userIds.push(user.id);
    await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role: role as "OWNER" | "OPERATOR" | "VIEWER" } });
    return { user, role: role as "OWNER" | "OPERATOR" | "VIEWER" };
  }));
  const context = Object.fromEntries(users.map(({ user, role }) => [role, { clientId: client.id, userId: user.id, role }])) as Record<"OWNER" | "OPERATOR" | "VIEWER", RequestContext>;
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "Test Page", credentialRef: "mock://facebook", publishCapability: "VERIFIED" } });
  await db.platformPolicy.create({ data: { clientId: client.id, platform: "facebook", source: "test" } });
  await db.promptVersion.create({ data: { clientId: client.id, capability: "multi_platform_content", version: suffix, instruction: "Confirmed facts only.", schemaName: "GeneratedDrafts", modelConfig: {} } });
  const product = await db.product.create({ data: { clientId: client.id, name: "Verified Chair", status: "CONFIRMED", fields: { create: [
    { clientId: client.id, key: "material", value: "verified steel", status: "CONFIRMED", source: "catalogue" },
    { clientId: client.id, key: "dimensions", value: "unverified dimensions", status: "PROPOSED", source: "draft" },
  ] } } });
  const input = { productId: product.id, theme: "Wholesale chair", objective: "Leads", accountIds: [account.id], assetIds: [] };
  return { client, context, account, product, input };
}

afterEach(async () => {
  for (const id of clientIds.splice(0)) await db.client.deleteMany({ where: { id } });
  for (const id of userIds.splice(0)) await db.user.deleteMany({ where: { id } });
});
afterAll(async () => { await db.$disconnect(); });

describe("SocialStrategy V1", () => {
  it("serializes first draft creation and rejects a stale empty editor", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      createSocialStrategyDraft(f.context.OWNER, { payload: payload() }),
      createSocialStrategyDraft(f.context.OPERATOR, { payload: payload({ coreMessage: "Another choice" }) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual(["STRATEGY_VERSION_CONFLICT"]);
    expect(await db.socialStrategy.count({ where: { clientId: f.client.id, status: "DRAFT" } })).toBe(1);
    expect(await db.socialStrategy.count({ where: { clientId: f.client.id } })).toBe(1);
  }, 15_000);

  it("rejects two editors saving from the same older draft", async () => {
    const f = await fixture();
    const first = await createSocialStrategyDraft(f.context.OWNER, { payload: payload() });
    const results = await Promise.allSettled([
      createSocialStrategyDraft(f.context.OWNER, { payload: payload({ coreMessage: "Owner revision" }), expectedDraftId: first.id }),
      createSocialStrategyDraft(f.context.OPERATOR, { payload: payload({ coreMessage: "Operator revision" }), expectedDraftId: first.id }),
    ]);
    const saved = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    expect(saved).toHaveLength(1);
    expect(saved[0].version).toBe(2);
    expect(results.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual(["STRATEGY_VERSION_CONFLICT"]);
    expect(await db.socialStrategy.count({ where: { clientId: f.client.id, status: "DRAFT" } })).toBe(1);
    expect(await db.socialStrategy.count({ where: { clientId: f.client.id } })).toBe(2);
  }, 15_000);

  it("confirms only after human review and records a lightweight context snapshot", async () => {
    const f = await fixture();
    const brand = await db.brandProfile.create({ data: { clientId: f.client.id, ctaRules: ["Ask for catalogue only"] } });
    const draft = await createSocialStrategyDraft(f.context.OPERATOR, { payload: payload(), effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" });
    expect(draft.status).toBe("DRAFT");
    const confirmed = await confirmSocialStrategy(f.context.OPERATOR, draft.id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedByUserId).toBe(f.context.OPERATOR.userId);
    const audit = await db.auditLog.findFirstOrThrow({ where: { clientId: f.client.id, action: "SOCIAL_STRATEGY_CONFIRMED", entityId: draft.id } });
    expect(audit.metadata).toMatchObject({ version: 1, brandProfileUpdatedAt: brand.updatedAt.toISOString(), clientTargetMarketsSnapshot: ["Canada"] });
    const next = await createSocialStrategyDraft(f.context.OWNER, { payload: payload({ businessGoal: "New cycle" }) });
    await confirmSocialStrategy(f.context.OWNER, next.id);
    expect(await db.socialStrategy.count({ where: { clientId: f.client.id, status: "CONFIRMED" } })).toBe(1);
    expect((await db.socialStrategy.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ARCHIVED");
  });

  it("rejects cross-client strategy relations at the database layer", async () => {
    const first = await fixture();
    const second = await fixture();
    const draft = await createSocialStrategyDraft(first.context.OWNER, { payload: payload() });
    await expect(db.contentPlan.create({ data: {
      clientId: second.client.id, productId: second.product.id, socialStrategyId: draft.id,
      theme: "Cross tenant", objective: "Should fail", channels: ["facebook"],
    } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("gates LIVE initial AI generation, pins confirmed strategy and preserves source priority", async () => {
    const f = await fixture("LIVE");
    await expect(generateContentPlan(f.context.OWNER, f.input)).rejects.toMatchObject({ code: "CONFIRMED_STRATEGY_REQUIRED" });
    expect(await db.contentPlan.count({ where: { clientId: f.client.id } })).toBe(0);
    await db.brandProfile.create({ data: { clientId: f.client.id, audience: "General brand audience", bannedPhrases: ["guaranteed"], ctaRules: ["Ask for catalogue only"] } });
    const draft = await createSocialStrategyDraft(f.context.OWNER, { payload: payload({ ctaGuidance: ["Request a quote"] }) });
    await confirmSocialStrategy(f.context.OWNER, draft.id);
    let captured: DraftGenerationInput | null = null;
    const adapter: TextGenerationAdapter = { async generate(input) { captured = input; return mock.generate(input); } };
    const result = await generateContentPlan(f.context.OWNER, f.input, adapter);
    expect(result.plan.socialStrategyId).toBe(draft.id);
    expect(result.generation).toMatchObject({ strategyProvenance: "CONFIRMED_BINDING", socialStrategyId: draft.id, socialStrategyVersion: 1, socialStrategyStatus: "CONFIRMED" });
    expect(result.items[0].currentVersion.sourceFacts).toMatchObject({ strategyProvenance: "CONFIRMED_BINDING", socialStrategyId: draft.id, socialStrategyVersion: 1, socialStrategyStatus: "CONFIRMED" });
    expect(captured!.targetMarkets).toEqual(["US"]);
    expect(captured!.confirmedFacts).toEqual([{ key: "material", value: "verified steel", source: "catalogue" }]);
    expect(JSON.stringify(captured)).not.toContain("unverified dimensions");
    expect(captured!.brandProfile?.ctaRules).toEqual(["Ask for catalogue only"]);
    expect(captured!.socialStrategy?.ctaGuidance).toEqual(["Request a quote"]);
    expect(captured!.brandProfile?.audience).toBe("General brand audience");
    expect(captured!.strategy).toMatchObject({ audience: "Furniture distributors", messageAngle: f.input.theme, contentGoal: f.input.objective, differentiation: ["material: verified steel"] });
    expect(captured!.instruction).toContain("BrandProfile");
    expect(await db.approval.count({ where: { clientId: f.client.id } })).toBe(0);
    expect(await db.publishJob.count({ where: { clientId: f.client.id } })).toBe(0);
  });

  it("rejects stale initial output if a new confirmed strategy replaces the pinned version during model work", async () => {
    const f = await fixture("LIVE");
    const first = await createSocialStrategyDraft(f.context.OWNER, { payload: payload() });
    await confirmSocialStrategy(f.context.OWNER, first.id);
    const replacement = await createSocialStrategyDraft(f.context.OWNER, { payload: payload({ coreMessage: "New confirmed choice" }) });
    const adapter: TextGenerationAdapter = { async generate(input) {
      await confirmSocialStrategy(f.context.OWNER, replacement.id);
      return mock.generate(input);
    } };
    await expect(generateContentPlan(f.context.OWNER, f.input, adapter)).rejects.toMatchObject({ code: "STALE_OPERATION" });
    expect(await db.contentPlan.count({ where: { clientId: f.client.id } })).toBe(0);
    expect(await db.approval.count({ where: { clientId: f.client.id } })).toBe(0);
    expect(await db.publishJob.count({ where: { clientId: f.client.id } })).toBe(0);
  });

  it("keeps AI rewrite and regenerate on the bound confirmed snapshot after replacement", async () => {
    const f = await fixture("LIVE");
    const first = await createSocialStrategyDraft(f.context.OWNER, { payload: payload() });
    await confirmSocialStrategy(f.context.OWNER, first.id);
    const generated = await generateContentPlan(f.context.OWNER, f.input, mock);
    const item = generated.items[0];
    const replacement = await createSocialStrategyDraft(f.context.OWNER, { payload: payload({ coreMessage: "New confirmed choice" }) });
    const adapter: TextGenerationAdapter = { async generate(input) {
      expect(input.socialStrategy?.id).toBe(first.id);
      expect(input.socialStrategy?.version).toBe(first.version);
      await confirmSocialStrategy(f.context.OWNER, replacement.id);
      return mock.generate(input);
    } };
    const regenerated = await regeneratePlatformVariant(f.context.OPERATOR, item.id, { expectedVersionId: item.currentVersionId }, adapter);
    expect(regenerated.sourceFacts).toMatchObject({ strategyProvenance: "CONFIRMED_BINDING", socialStrategyId: first.id, socialStrategyVersion: first.version });
    const rewritten = await rewriteContent(f.context.OPERATOR, item.id, { expectedVersionId: regenerated.id, action: "shorten" }, mock);
    expect(rewritten.sourceFacts).toMatchObject({ strategyProvenance: "CONFIRMED_BINDING", socialStrategyId: first.id, socialStrategyVersion: first.version, socialStrategyStatus: "ARCHIVED" });
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: generated.plan.id } })).socialStrategyId).toBe(first.id);
    expect((await db.socialStrategy.findUniqueOrThrow({ where: { id: replacement.id } })).status).toBe("CONFIRMED");
    const manual = await updateDraftContent(f.context.OPERATOR, item.id, { expectedVersionId: rewritten.id, text: "A human revision after strategy replacement." });
    expect(manual.source).toBe("AUTOSAVE");
  });

  it("rejects a never-confirmed archived draft as a LIVE historical binding", async () => {
    const f = await fixture("DEMO");
    const draft = await createSocialStrategyDraft(f.context.OWNER, { payload: payload() });
    const generated = await generateContentPlan(f.context.OWNER, f.input);
    await createSocialStrategyDraft(f.context.OWNER, { payload: payload({ coreMessage: "Later draft" }), expectedDraftId: draft.id });
    await db.client.update({ where: { id: f.client.id }, data: { mode: "LIVE" } });
    await expect(rewriteContent(f.context.OWNER, generated.items[0].id, { expectedVersionId: generated.items[0].currentVersionId, action: "shorten" })).rejects.toMatchObject({ code: "CONFIRMED_STRATEGY_REQUIRED" });
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: generated.plan.id } })).socialStrategyId).toBe(draft.id);
  });

  it("labels DEMO draft preview and unbound fallback without auto-confirming a strategy", async () => {
    const demo = await fixture("DEMO");
    const draft = await createSocialStrategyDraft(demo.context.OWNER, { payload: payload({ businessGoal: "" }) });
    const preview = await generateContentPlan(demo.context.OWNER, demo.input);
    expect(preview.generation).toMatchObject({ strategyProvenance: "DRAFT_PREVIEW", socialStrategyId: draft.id, socialStrategyVersion: 1, socialStrategyStatus: "DRAFT" });
    expect(await db.socialStrategy.count({ where: { clientId: demo.client.id, status: "CONFIRMED" } })).toBe(0);
    const other = await fixture("DRAFT");
    await db.brandProfile.create({ data: { clientId: other.client.id, audience: "Default brand buyers" } });
    let fallbackInput: DraftGenerationInput | null = null;
    const adapter: TextGenerationAdapter = { async generate(input) { fallbackInput = input; return mock.generate(input); } };
    const fallback = await generateContentPlan(other.context.OWNER, other.input, adapter);
    expect(fallback.generation).toMatchObject({ strategyProvenance: "UNBOUND_FALLBACK", socialStrategyId: null, socialStrategyVersion: null, socialStrategyStatus: null });
    expect(fallback.plan.socialStrategyId).toBeNull();
    expect(fallbackInput!.strategy?.audience).toBe("Default brand buyers");
  });

  it("keeps legacy unbound manual flow available while rejecting LIVE AI rewrite and regenerate", async () => {
    const f = await fixture("DEMO");
    const generated = await generateContentPlan(f.context.OWNER, f.input);
    const item = generated.items[0];
    await db.contentVersion.update({ where: { id: item.currentVersionId! }, data: { sourceFacts: { confirmedFacts: [{ key: "material", value: "verified steel", source: "catalogue" }] } } });
    await db.client.update({ where: { id: f.client.id }, data: { mode: "LIVE" } });
    const oldVersion = await db.contentVersion.findUniqueOrThrow({ where: { id: item.currentVersionId! } });
    expect(readStrategyProvenance(oldVersion.sourceFacts)).toBe("LEGACY_UNBOUND");
    await expect(rewriteContent(f.context.OWNER, item.id, { expectedVersionId: item.currentVersionId, action: "shorten" })).rejects.toMatchObject({ code: "STRATEGY_BINDING_REQUIRED" });
    await expect(regeneratePlatformVariant(f.context.OWNER, item.id, { expectedVersionId: item.currentVersionId })).rejects.toMatchObject({ code: "STRATEGY_BINDING_REQUIRED" });
    const saved = await updateDraftContent(f.context.OPERATOR, item.id, { expectedVersionId: item.currentVersionId, text: "Verified steel chair for wholesale buyers." });
    expect(readStrategyProvenance(saved.sourceFacts)).toBe("LEGACY_UNBOUND");
    await submitForReview(f.context.OPERATOR, item.id, saved.id);
    await reviewContent(f.context.OWNER, item.id, "APPROVED", "Human approval", saved.id);
    await expect(schedulePublication(f.context.OWNER, item.id)).rejects.toMatchObject({ code: "LIVE_CONNECTION_REQUIRED" });
    expect(await db.approval.count({ where: { clientId: f.client.id } })).toBe(1);
  });

  it("allows OWNER and OPERATOR to manage drafts while VIEWER remains read-only", async () => {
    const f = await fixture();
    const first = await createSocialStrategyDraft(f.context.OPERATOR, { payload: payload() });
    expect((await listSocialStrategies(f.context.VIEWER)).map((item) => item.id)).toContain(first.id);
    await expect(createSocialStrategyDraft(f.context.VIEWER, { payload: payload() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmSocialStrategy(f.context.VIEWER, first.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await confirmSocialStrategy(f.context.OWNER, first.id)).status).toBe("CONFIRMED");
  });
});
