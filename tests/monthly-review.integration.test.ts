import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { MonthlyReviewFactsV1Schema } from "../src/lib/monthly-review-contract";
import { buildMonthlyReviewFactsV1, resolveMonthlyReviewPeriod } from "../src/services/monthly-review-service";

const clientIds: string[] = [];

async function fixture(timezone = "Asia/Shanghai") {
  const suffix = randomUUID();
  const client = await db.client.create({
    data: { slug: `monthly-${suffix}`, name: "Monthly fixture", timezone, mode: "LIVE", targetMarkets: ["US"] },
  });
  clientIds.push(client.id);
  const account = await db.socialAccount.create({
    data: { clientId: client.id, platform: "facebook", displayName: "Monthly Page" },
  });
  const plan = await db.contentPlan.create({
    data: { clientId: client.id, theme: "Test", objective: "Test", channels: ["facebook"] },
  });
  const item = await db.contentItem.create({
    data: { clientId: client.id, planId: plan.id, accountId: account.id, platform: "facebook" },
  });
  const version = await db.contentVersion.create({
    data: {
      clientId: client.id, contentItemId: item.id, version: 1, text: "Test", generator: "manual",
      generationLabel: "manual", sourceFacts: {},
    },
  });
  return { client, account, version };
}

async function facts(client: Awaited<ReturnType<typeof fixture>>["client"], month = "2026-08", asOf = new Date()) {
  return db.$transaction((tx) => buildMonthlyReviewFactsV1(tx, client, month, asOf), { isolationLevel: "RepeatableRead" });
}

async function createCohortJob(base: Awaited<ReturnType<typeof fixture>>, status: "UNKNOWN" | "FAILED" | "WAITING_CONFIGURATION", environment: "LIVE" | "SIMULATED", simulated: boolean) {
  const account = await db.socialAccount.create({
    data: { clientId: base.client.id, platform: "facebook", displayName: `Cohort ${randomUUID()}` },
  });
  const originalItem = await db.contentItem.findUniqueOrThrow({ where: { id: base.version.contentItemId } });
  const item = await db.contentItem.create({
    data: { clientId: base.client.id, accountId: account.id, planId: originalItem.planId, platform: "facebook" },
  });
  const version = await db.contentVersion.create({
    data: { clientId: base.client.id, contentItemId: item.id, version: 1, text: "Cohort", generator: "test", generationLabel: "test", sourceFacts: {} },
  });
  return db.publishJob.create({
    data: {
      clientId: base.client.id, accountId: account.id, contentVersionId: version.id,
      idempotencyKey: `monthly-cohort-${randomUUID()}`, adapter: environment === "LIVE" ? "meta" : "mock",
      status, environment, simulated, createdAt: new Date("2026-08-15T08:00:00Z"),
    },
  });
}

afterEach(async () => {
  for (const clientId of clientIds.splice(0)) await db.client.deleteMany({ where: { id: clientId } });
});
afterAll(async () => { await db.$disconnect(); });

describe("MONTHLY_V1 client-local calendar boundaries", () => {
  it("uses Shanghai month bounds and marks the current month partial", () => {
    const historical = resolveMonthlyReviewPeriod("2026-09", "Asia/Shanghai", new Date("2026-10-15T00:00:00Z"));
    expect(historical.start.toISOString()).toBe("2026-08-31T16:00:00.000Z");
    expect(historical.end.toISOString()).toBe("2026-09-30T16:00:00.000Z");
    expect(historical.partial).toBe(false);
    const current = resolveMonthlyReviewPeriod("2026-09", "Asia/Shanghai", new Date("2026-09-27T00:00:00Z"));
    expect(current.partial).toBe(true);
    expect(current.effectiveEnd.toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(() => resolveMonthlyReviewPeriod("2026-10", "Asia/Shanghai", new Date("2026-09-27T00:00:00Z")))
      .toThrowError(expect.objectContaining({ code: "FUTURE_REVIEW_MONTH" }));
  });

  it("uses calendar months across daylight saving transitions", () => {
    const march = resolveMonthlyReviewPeriod("2026-03", "America/New_York", new Date("2026-12-01T00:00:00Z"));
    expect(march.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    expect((march.end.getTime() - march.start.getTime()) / 3_600_000).toBe(743);
    const november = resolveMonthlyReviewPeriod("2026-11", "America/New_York", new Date("2026-12-15T00:00:00Z"));
    expect(november.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(november.end.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect((november.end.getTime() - november.start.getTime()) / 3_600_000).toBe(721);
  });

  it("does not reinterpret four-digit years below 1970 as 1900-series dates", () => {
    const early = resolveMonthlyReviewPeriod("0099-02", "UTC", new Date("2026-09-01T00:00:00Z"));
    expect(early.start.toISOString()).toBe("0099-02-01T00:00:00.000Z");
    expect(early.end.toISOString()).toBe("0099-03-01T00:00:00.000Z");
    expect(() => resolveMonthlyReviewPeriod("0000-02", "UTC", new Date("2026-09-01T00:00:00Z")))
      .toThrowError(expect.objectContaining({ code: "INVALID_REVIEW_MONTH" }));
  });
});

describe("MONTHLY_V1 facts", () => {
  it("keeps empty values missing and validates a versioned result", async () => {
    const { client } = await fixture();
    const result = await facts(client);
    expect(MonthlyReviewFactsV1Schema.parse(result)).toEqual(result);
    expect(result.schemaVersion).toBe("MONTHLY_V1");
    expect(result.publishing.real.total).toBe(0);
    expect(result.metrics.real.samples).toEqual([]);
    expect(result.metrics.real.freshness).toBe("MISSING");
    expect(result.metrics.syncHealth.counts.MISSING).toBe(1);
    expect(result.metrics.syncHealth.counts.FAILED).toBe(0);
    expect(result.leads.categoryCounts).toEqual({
      PROCUREMENT: 0, WHOLESALE: 0, INQUIRY: 0, CATALOG_REQUEST: 0,
      SUPPLY_REQUEST: 0, GENERAL: 0, SPAM: 0,
    });
    expect(result.leads.salesFeedbackPresentAsOf).toBe(0);
    expect(result.limitations.join(" ")).toContain("缺失不等于 0");
  });

  it("keeps current sync health separate from metric sample freshness", async () => {
    const base = await fixture();
    const states = ["FAILED", "SYNCING", "MISSING", "FRESH", "STALE"] as const;
    const accounts = [base.account];
    for (let index = 1; index < states.length; index += 1) {
      accounts.push(await db.socialAccount.create({
        data: { clientId: base.client.id, platform: "facebook", displayName: `Metric account ${states[index]}` },
      }));
    }
    await db.socialAccount.create({
      data: { clientId: base.client.id, platform: "linkedin", displayName: "Manual without metrics", metadata: { managementMode: "MANUAL" } },
    });
    await db.socialAccount.create({
      data: { clientId: base.client.id, platform: "instagram", displayName: "API without registry metrics" },
    });
    for (const [index, status] of states.entries()) {
      if (status === "MISSING") continue;
      await db.analyticsSyncState.create({
        data: {
          clientId: base.client.id, accountId: accounts[index].id, scope: "metrics", status,
          lastStartedAt: status === "SYNCING" ? new Date() : null,
          lastSucceededAt: status === "FRESH" ? new Date() : null,
          lastFailedAt: status === "FAILED" ? new Date() : null,
        },
      });
    }
    await db.metricSnapshot.create({
      data: {
        clientId: base.client.id, accountId: accounts[0].id, metricKey: "reach", numericValue: 10,
        availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date(), source: "test",
        periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"),
      },
    });
    const result = await facts(base.client);
    expect(result.metrics.real.freshness).toBe("FRESH");
    expect(result.metrics.syncHealth.scope).toBe("metrics");
    expect(result.metrics.syncHealth.accounts).toHaveLength(5);
    expect(result.metrics.syncHealth.counts).toEqual({ FRESH: 1, STALE: 1, SYNCING: 1, FAILED: 1, MISSING: 1 });
    expect(result.metrics.syncHealth.accounts.find((entry) => entry.accountId === accounts[0].id)?.status).toBe("FAILED");
    expect(result.limitations.join(" ")).toContain("FAILED");
    expect(result.limitations.join(" ")).toContain("正在同步");
    expect(result.limitations.join(" ")).toContain("MISSING 不等于 FAILED");
  });

  it("splits created publish cohort into real and simulated status totals", async () => {
    const base = await fixture();
    await createCohortJob(base, "UNKNOWN", "LIVE", false);
    await createCohortJob(base, "FAILED", "LIVE", false);
    await createCohortJob(base, "UNKNOWN", "SIMULATED", false);
    await createCohortJob(base, "WAITING_CONFIGURATION", "LIVE", true);
    const result = await facts(base.client);
    expect(result.publishing.createdCohort.real.total).toBe(2);
    expect(result.publishing.createdCohort.real.statuses).toMatchObject({ UNKNOWN: 1, FAILED: 1, WAITING_CONFIGURATION: 0 });
    expect(result.publishing.createdCohort.simulated.total).toBe(2);
    expect(result.publishing.createdCohort.simulated.statuses).toMatchObject({ UNKNOWN: 1, FAILED: 0, WAITING_CONFIGURATION: 1 });
    expect(result.publishing.createdCohort.real.total + result.publishing.createdCohort.simulated.total).toBe(4);
    expect(Object.values(result.publishing.createdCohort.real.statuses).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(Object.values(result.publishing.createdCohort.simulated.statuses).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(result.publishing.real.total).toBe(0);
    expect(result.publishing.simulated.total).toBe(0);
    expect(result.limitations.join(" ")).toContain("模拟发布");
  });

  it("counts seven lead categories and nonblank sales feedback within the created cohort", async () => {
    const base = await fixture();
    const foreign = await fixture();
    const categories = ["PROCUREMENT", "WHOLESALE", "INQUIRY", "CATALOG_REQUEST", "SUPPLY_REQUEST", "GENERAL", "SPAM"] as const;
    for (const [index, category] of categories.entries()) {
      const interaction = await db.interaction.create({
        data: {
          clientId: base.client.id, accountId: base.account.id, platform: "facebook",
          platformRecordId: `monthly-lead-${randomUUID()}`, interactionType: "COMMENT", body: category,
          occurredAt: new Date("2026-08-10T08:00:00Z"), importedAt: new Date("2026-08-11T08:00:00Z"),
        },
      });
      await db.lead.create({
        data: {
          clientId: base.client.id, interactionId: interaction.id, category, priority: "NORMAL",
          rationale: "Test", salesFeedback: index === 0 ? "  Reviewed  " : index === 1 ? "   " : null,
          createdAt: new Date("2026-08-12T08:00:00Z"),
        },
      });
    }
    const foreignInteraction = await db.interaction.create({
      data: {
        clientId: foreign.client.id, accountId: foreign.account.id, platform: "facebook",
        platformRecordId: `monthly-foreign-lead-${randomUUID()}`, interactionType: "COMMENT", body: "Foreign",
        occurredAt: new Date("2026-08-10T08:00:00Z"), importedAt: new Date("2026-08-11T08:00:00Z"),
      },
    });
    await db.lead.create({
      data: {
        clientId: foreign.client.id, interactionId: foreignInteraction.id, category: "SPAM",
        priority: "HIGH", rationale: "Other tenant", salesFeedback: "Foreign feedback",
        createdAt: new Date("2026-08-12T08:00:00Z"),
      },
    });
    const result = await facts(base.client);
    expect(result.leads.recordsCreatedInMonth).toBe(7);
    expect(result.leads.categoryCounts).toEqual(Object.fromEntries(categories.map((category) => [category, 1])));
    expect(result.leads.salesFeedbackPresentAsOf).toBe(1);
  });

  it("retains MOCK provenance when the only mock metric is not canonical", async () => {
    const { client, account } = await fixture();
    await db.metricSnapshot.create({
      data: {
        clientId: client.id, accountId: account.id, metricKey: "qualified_leads",
        numericValue: 4, availability: "AVAILABLE", dataKind: "MOCK",
        fetchedAt: new Date("2026-08-15T08:00:00Z"), source: "test",
      },
    });
    const result = await facts(client);
    expect(result.metrics.mock.samples).toEqual([]);
    expect(result.metrics.mockRawSnapshotCount).toBe(1);
    expect(result.metrics.excludedNonCanonicalCount).toBe(1);
    expect(result.limitations.join(" ")).toContain("MOCK");
  });

  it("excludes selected Instagram API accounts without METRICS from real metric coverage", async () => {
    const base = await fixture();
    await db.socialAccount.update({ where: { id: base.account.id }, data: { isSelected: false } });
    await db.socialAccount.create({
      data: { clientId: base.client.id, platform: "instagram", displayName: "Instagram without metrics" },
    });
    const result = await facts(base.client);
    expect(result.metrics.accountCoverage).toMatchObject({
      selectedAccountCount: 1, selectedApiAccountCount: 1, selectedManualAccountCount: 0,
      selectedMetricsApiAccountCount: 0, missingRealMetricsApiAccountCount: 0,
    });
    expect(result.metrics.syncHealth.accounts).toEqual([]);
    expect(result.limitations.join(" ")).not.toContain("API 指标账号覆盖不完整");
  });

  it("counts only Facebook in real metric coverage when Instagram has no METRICS path", async () => {
    const base = await fixture();
    await db.socialAccount.create({
      data: { clientId: base.client.id, platform: "instagram", displayName: "Instagram without metrics" },
    });
    await db.metricSnapshot.create({
      data: {
        clientId: base.client.id, accountId: base.account.id, metricKey: "reach", numericValue: 10,
        availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date("2026-08-15T08:00:00Z"), source: "test",
      },
    });
    const result = await facts(base.client);
    expect(result.metrics.accountCoverage).toMatchObject({
      selectedApiAccountCount: 2, selectedMetricsApiAccountCount: 1,
      missingRealMetricsApiAccountCount: 0,
    });
    expect(result.limitations.join(" ")).not.toContain("API 指标账号覆盖不完整");
  });

  it("counts missing Facebook coverage once without counting Instagram", async () => {
    const base = await fixture();
    await db.socialAccount.create({
      data: { clientId: base.client.id, platform: "instagram", displayName: "Instagram without metrics" },
    });
    const result = await facts(base.client);
    expect(result.metrics.accountCoverage).toMatchObject({
      selectedApiAccountCount: 2, selectedMetricsApiAccountCount: 1,
      missingRealMetricsApiAccountCount: 1,
    });
    expect(result.limitations.join(" ")).toContain("API 指标账号覆盖不完整");
  });

  it("does not treat manual accounts as missing API metric coverage", async () => {
    const { client, account } = await fixture();
    await db.socialAccount.create({
      data: {
        clientId: client.id, platform: "linkedin", displayName: "Manual LinkedIn",
        metadata: { managementMode: "MANUAL", profileUrl: "https://example.com/profile" },
      },
    });
    await db.metricSnapshot.create({
      data: {
        clientId: client.id, accountId: account.id, metricKey: "reach", numericValue: 10,
        availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date("2026-08-15T08:00:00Z"), source: "test",
      },
    });
    const result = await facts(client);
    expect(result.metrics.accountCoverage).toEqual({
      selectedAccountCount: 2, selectedApiAccountCount: 1, selectedManualAccountCount: 1,
      selectedMetricsApiAccountCount: 1, realAccountCount: 1, mockAccountCount: 0,
      missingRealMetricsApiAccountCount: 0,
    });
    expect(result.limitations.join(" ")).not.toContain("API 指标账号覆盖不完整");
  });

  it("excludes records whose account or interaction points at another tenant", async () => {
    const own = await fixture();
    const foreign = await fixture();
    const observedAt = new Date("2026-08-15T08:00:00Z");
    await db.metricSnapshot.create({
      data: {
        clientId: own.client.id, accountId: foreign.account.id, metricKey: "reach",
        numericValue: 777, availability: "AVAILABLE", dataKind: "REAL",
        fetchedAt: observedAt, source: "test",
      },
    });
    const interaction = await db.interaction.create({
      data: {
        clientId: own.client.id, accountId: foreign.account.id, platform: "facebook",
        platformRecordId: `cross-tenant-${randomUUID()}`, interactionType: "COMMENT",
        body: "Foreign account", occurredAt: observedAt, importedAt: observedAt,
      },
    });
    await db.lead.create({
      data: {
        clientId: own.client.id, interactionId: interaction.id, category: "INQUIRY",
        priority: "HIGH", rationale: "Corrupt tenant association", createdAt: observedAt,
      },
    });
    await db.publishJob.create({
      data: {
        clientId: own.client.id, accountId: foreign.account.id,
        contentVersionId: own.version.id, idempotencyKey: `cross-tenant-${randomUUID()}`,
        adapter: "manual", status: "PUBLISHED", environment: "LIVE", simulated: false,
        publishedAt: observedAt, createdAt: observedAt,
      },
    });
    const result = await facts(own.client);
    expect(result.metrics.real.samples).toEqual([]);
    expect(result.publishing.real.total).toBe(0);
    expect(result.publishing.createdCohort.real.total).toBe(0);
    expect(result.publishing.createdCohort.simulated.total).toBe(0);
    expect(result.interactions.occurredInMonth).toBe(0);
    expect(result.interactions.importedInMonth).toBe(0);
    expect(result.leads.recordsCreatedInMonth).toBe(0);
  });

  it("separates REAL, MOCK, simulated publication, event times and current status cohort", async () => {
    const { client, account, version } = await fixture();
    const other = await fixture();
    const august = new Date("2026-08-15T08:00:00Z");
    await db.publishJob.create({
      data: {
        clientId: client.id, accountId: account.id, contentVersionId: version.id,
        idempotencyKey: `monthly-manual-${randomUUID()}`, adapter: "manual",
        status: "PUBLISHED", environment: "LIVE", simulated: false,
        publishedAt: new Date("2026-08-10T08:00:00Z"), createdAt: new Date("2026-07-31T08:00:00Z"),
      },
    });
    const secondAccount = await db.socialAccount.create({
      data: { clientId: client.id, platform: "facebook", displayName: "Second page" },
    });
    const secondItem = await db.contentItem.create({
      data: { clientId: client.id, planId: (await db.contentItem.findUniqueOrThrow({ where: { id: version.contentItemId } })).planId, accountId: secondAccount.id, platform: "facebook" },
    });
    const secondVersion = await db.contentVersion.create({
      data: { clientId: client.id, contentItemId: secondItem.id, version: 1, text: "Mock", generator: "test", generationLabel: "test", sourceFacts: {} },
    });
    await db.publishJob.create({
      data: {
        clientId: client.id, accountId: secondAccount.id, contentVersionId: secondVersion.id,
        idempotencyKey: `monthly-mock-${randomUUID()}`, adapter: "mock",
        status: "PUBLISHED", environment: "SIMULATED", simulated: true,
        publishedAt: new Date("2026-08-20T08:00:00Z"), createdAt: new Date("2026-08-01T08:00:00Z"),
      },
    });
    const thirdAccount = await db.socialAccount.create({
      data: { clientId: client.id, platform: "facebook", displayName: "Third page" },
    });
    const thirdItem = await db.contentItem.create({
      data: { clientId: client.id, planId: (await db.contentItem.findUniqueOrThrow({ where: { id: version.contentItemId } })).planId, accountId: thirdAccount.id, platform: "facebook" },
    });
    const thirdVersion = await db.contentVersion.create({
      data: { clientId: client.id, contentItemId: thirdItem.id, version: 1, text: "Waiting", generator: "test", generationLabel: "test", sourceFacts: {} },
    });
    await db.publishJob.create({
      data: {
        clientId: client.id, accountId: thirdAccount.id, contentVersionId: thirdVersion.id,
        idempotencyKey: `monthly-waiting-${randomUUID()}`, adapter: "meta",
        status: "WAITING_CONFIGURATION", environment: "LIVE", simulated: false,
        createdAt: new Date("2026-08-05T08:00:00Z"),
      },
    });
    await db.metricSnapshot.createMany({ data: [
      { clientId: client.id, accountId: account.id, metricKey: "impressions", numericValue: 100, availability: "AVAILABLE", dataKind: "REAL", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), fetchedAt: new Date("2026-08-15T07:00:00Z"), source: "test" },
      { clientId: client.id, accountId: account.id, metricKey: "impressions", numericValue: null, availability: "READ_FAILED", dataKind: "REAL", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), fetchedAt: august, source: "test" },
      { clientId: client.id, accountId: account.id, metricKey: "mock_impressions", numericValue: 999, availability: "AVAILABLE", dataKind: "MOCK", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), fetchedAt: august, source: "test" },
      { clientId: client.id, accountId: account.id, metricKey: "reach", numericValue: 0, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: august, source: "test" },
      { id: `monthly-like-a-${randomUUID()}`, clientId: client.id, accountId: account.id, metricKey: "likes", numericValue: 1, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: august, source: "test" },
      { id: `monthly-like-b-${randomUUID()}`, clientId: client.id, accountId: account.id, metricKey: "likes", numericValue: 2, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: august, source: "test" },
      { clientId: client.id, accountId: account.id, metricKey: "qualified_leads", numericValue: 45, availability: "AVAILABLE", dataKind: "MOCK", fetchedAt: august, source: "test" },
      { clientId: other.client.id, accountId: other.account.id, metricKey: "impressions", numericValue: 123456, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: august, source: "test" },
    ] });
    const lateInteraction = await db.interaction.create({
      data: { clientId: client.id, accountId: account.id, platform: "facebook", platformRecordId: `monthly-late-${randomUUID()}`, interactionType: "COMMENT", body: "August event", occurredAt: new Date("2026-08-20T00:00:00Z"), importedAt: new Date("2026-09-02T00:00:00Z") },
    });
    const importedInteraction = await db.interaction.create({
      data: { clientId: client.id, accountId: account.id, platform: "facebook", platformRecordId: `monthly-import-${randomUUID()}`, interactionType: "COMMENT", body: "July event", occurredAt: new Date("2026-07-20T00:00:00Z"), importedAt: new Date("2026-08-02T00:00:00Z") },
    });
    await db.lead.create({
      data: { clientId: client.id, interactionId: importedInteraction.id, category: "INQUIRY", priority: "HIGH", rationale: "Test", handoffStatus: "WAITING_FEEDBACK", createdAt: new Date("2026-08-03T00:00:00Z") },
    });
    const result = await facts(client);
    expect(lateInteraction.id).toBeTruthy();
    expect(result.publishing.real).toEqual({ total: 1, api: 0, manual: 1 });
    expect(result.publishing.simulated).toEqual({ total: 1, api: 1, manual: 0 });
    expect(result.publishing.createdCohort.real.statuses.WAITING_CONFIGURATION).toBe(1);
    expect(result.publishing.createdCohort.real.total).toBe(1);
    expect(result.publishing.createdCohort.simulated.total).toBe(1);
    expect(result.interactions).toEqual({ occurredInMonth: 1, importedInMonth: 1, lateImportedForMonth: 1 });
    expect(result.leads).toMatchObject({ recordsCreatedInMonth: 1, highOrUrgentAsOf: 1 });
    expect(result.metrics.real.samples.find((sample) => sample.key === "impressions")?.value).toBeNull();
    expect(result.metrics.real.samples.find((sample) => sample.key === "reach")?.value).toBe("0");
    expect(result.metrics.real.samples.find((sample) => sample.key === "likes")?.value).toBe("2");
    expect(result.metrics.mock.samples.find((sample) => sample.key === "impressions")?.value).toBe("999");
    expect(result.metrics.accountCoverage).toEqual({
      selectedAccountCount: 3, selectedApiAccountCount: 3, selectedManualAccountCount: 0,
      selectedMetricsApiAccountCount: 3, realAccountCount: 1, mockAccountCount: 1,
      missingRealMetricsApiAccountCount: 2,
    });
    expect(result.metrics.excludedNonCanonicalCount).toBe(1);
    expect(result.metrics.mockRawSnapshotCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain("123456");
    expect(result.limitations.join(" ")).toContain("模拟发布");
  });
});
