import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "../src/lib/db";
import { MonthlyReviewFactsV1Schema } from "../src/lib/monthly-review-contract";
import { AppError } from "../src/lib/errors";
import type { RequestContext } from "../src/lib/context";
import { classifyOperationReportFacts, deriveMonthlyReviewNextActions, generateMonthlyOperationReport } from "../src/services/report-service";

const clients: string[] = [];
const users: string[] = [];
const asOf = new Date("2026-09-20T00:00:00.000Z");

async function fixture(role: RequestContext["role"] = "OWNER") {
  const unique = randomUUID();
  const client = await db.client.create({
    data: { slug: `monthly-report-${unique}`, name: `Monthly report ${unique}`, mode: "DRAFT", isDemo: false, timezone: "Asia/Shanghai" },
  });
  clients.push(client.id);
  const user = await db.user.create({ data: { email: `monthly-report-${unique}@example.local`, displayName: "Monthly tester", passwordHash: "test-only" } });
  users.push(user.id);
  await db.clientMembership.create({ data: { clientId: client.id, userId: user.id, role } });
  const account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "Fixture page", createdAt: new Date("2026-09-01T00:00:00.000Z") } });
  const context: RequestContext = { clientId: client.id, userId: user.id, role };
  return { client, account, context };
}

afterAll(async () => {
  await db.client.deleteMany({ where: { id: { in: clients } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

describe("MONTHLY_V1 OperationReport persistence", () => {
  it("validates facts, appends immutable snapshots, and audits the generator", async () => {
    const { client, account, context } = await fixture();
    const first = await generateMonthlyOperationReport(context, "2026-09", asOf);
    const firstFacts = MonthlyReviewFactsV1Schema.parse(first.facts);
    expect(firstFacts.schemaVersion).toBe("MONTHLY_V1");
    expect(firstFacts.period.startUtc).toBe("2026-08-31T16:00:00.000Z");
    expect(firstFacts.period.partial).toBe(true);
    expect(firstFacts.metrics.real.samples).toHaveLength(0);
    expect(first.simulated).toBe(false);
    expect(first.hypotheses).toEqual([]);
    expect((first.recommendations as string[]).length).toBeGreaterThan(0);
    await db.metricSnapshot.create({ data: {
      clientId: client.id, accountId: account.id, metricKey: "impressions", numericValue: 17,
      availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date("2026-09-10T00:00:00.000Z"), createdAt: new Date("2026-09-10T00:00:00.000Z"), source: "test-snapshot",
    } });
    const second = await generateMonthlyOperationReport(context, "2026-09", asOf);
    const secondFacts = MonthlyReviewFactsV1Schema.parse(second.facts);
    expect(second.id).not.toBe(first.id);
    expect(secondFacts.metrics.real.samples).toHaveLength(1);
    expect(secondFacts.metrics.real.samples[0].value).toBe("17");
    const savedFirst = await db.operationReport.findUniqueOrThrow({ where: { id: first.id } });
    expect(savedFirst.facts).toEqual(first.facts);
    expect(MonthlyReviewFactsV1Schema.parse(savedFirst.facts).metrics.real.samples).toHaveLength(0);
    expect(await db.auditLog.count({ where: { clientId: client.id, action: "MONTHLY_REVIEW_GENERATED", entityType: "OperationReport" } })).toBe(2);
  });

  it("keeps REAL and MOCK separate and marks a mixed snapshot", async () => {
    const { client, account, context } = await fixture();
    await db.metricSnapshot.createMany({ data: [
      { clientId: client.id, accountId: account.id, metricKey: "impressions", numericValue: 5, availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date("2026-09-08T00:00:00.000Z"), createdAt: new Date("2026-09-08T00:00:00.000Z"), source: "real" },
      { clientId: client.id, accountId: account.id, metricKey: "impressions", numericValue: 99, availability: "AVAILABLE", dataKind: "MOCK", fetchedAt: new Date("2026-09-09T00:00:00.000Z"), createdAt: new Date("2026-09-09T00:00:00.000Z"), source: "mock" },
    ] });
    const report = await generateMonthlyOperationReport(context, "2026-09", asOf);
    const facts = MonthlyReviewFactsV1Schema.parse(report.facts);
    expect(report.simulated).toBe(true);
    expect(facts.metrics.real.samples[0].value).toBe("5");
    expect(facts.metrics.mock.samples[0].value).toBe("99");
    expect(facts.metrics.real.samples).toHaveLength(1);
    expect(facts.metrics.mock.samples).toHaveLength(1);
  });

  it("labels a noncanonical MOCK source as simulated without treating it as a metric value", async () => {
    const { client, account, context } = await fixture();
    await db.metricSnapshot.create({ data: {
      clientId: client.id, accountId: account.id, metricKey: "private_unknown_metric", numericValue: 123,
      availability: "AVAILABLE", dataKind: "MOCK", fetchedAt: new Date("2026-09-11T00:00:00.000Z"),
      createdAt: new Date("2026-09-11T00:00:00.000Z"), source: "mock-unknown",
    } });
    const report = await generateMonthlyOperationReport(context, "2026-09", asOf);
    const facts = MonthlyReviewFactsV1Schema.parse(report.facts);
    expect(report.simulated).toBe(true);
    expect(facts.metrics.mockRawSnapshotCount).toBe(1);
    expect(facts.metrics.mock.samples).toHaveLength(0);
    expect(facts.metrics.excludedNonCanonicalCount).toBe(1);
  });

  it("does not interpret an unversioned historical report as MONTHLY_V1", async () => {
    const { client } = await fixture();
    const legacyFacts = { publishedPosts: { total: 3, real: 2, mock: 1 }, qualifiedLeadRecords: 2 };
    const legacy = await db.operationReport.create({ data: {
      clientId: client.id,
      periodStart: new Date("2026-08-01T00:00:00.000Z"), periodEnd: new Date("2026-08-08T00:00:00.000Z"),
      facts: legacyFacts, dataLimitations: ["旧口径"], hypotheses: [], recommendations: [], simulated: true,
    } });
    expect(classifyOperationReportFacts(legacy.facts)).toEqual({ kind: "LEGACY" });
    expect(classifyOperationReportFacts({ schemaVersion: "MONTHLY_V2" })).toEqual({ kind: "UNSUPPORTED" });
    expect(classifyOperationReportFacts({ schemaVersion: "MONTHLY_V1" })).toEqual({ kind: "UNSUPPORTED" });
    const saved = await db.operationReport.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(saved.facts).toEqual(legacyFacts);
  });

  it("proposes evidence checks for UNKNOWN and configuration states without inventing a hypothesis", async () => {
    const { context } = await fixture();
    const report = await generateMonthlyOperationReport(context, "2026-09", asOf);
    const facts = MonthlyReviewFactsV1Schema.parse(report.facts);
    const withUnresolved = {
      ...facts,
      publishing: {
        ...facts.publishing,
        createdCohort: {
          ...facts.publishing.createdCohort,
          statuses: { ...facts.publishing.createdCohort.statuses, UNKNOWN: 1, WAITING_CONFIGURATION: 1 },
        },
      },
    };
    const actions = deriveMonthlyReviewNextActions(withUnresolved);
    expect(actions.join(" ")).toContain("UNKNOWN");
    expect(actions.join(" ")).toContain("WAITING_CONFIGURATION");
    expect(actions.join(" ")).not.toContain("表现提升");
  });

  it("rejects a future month and VIEWER generation without inserting a report", async () => {
    const { client, context } = await fixture("VIEWER");
    await expect(generateMonthlyOperationReport(context, "2026-09", asOf)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" } satisfies Partial<AppError>);
    await expect(generateMonthlyOperationReport({ ...context, role: "OPERATOR" }, "2026-10", asOf)).rejects.toMatchObject({ status: 400, code: "FUTURE_REVIEW_MONTH" } satisfies Partial<AppError>);
    expect(await db.operationReport.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("does not include another tenant's metrics", async () => {
    const own = await fixture();
    const other = await fixture();
    await db.metricSnapshot.create({ data: {
      clientId: other.client.id, accountId: other.account.id, metricKey: "impressions", numericValue: 888,
      availability: "AVAILABLE", dataKind: "REAL", fetchedAt: new Date("2026-09-10T00:00:00.000Z"), createdAt: new Date("2026-09-10T00:00:00.000Z"), source: "other-tenant",
    } });
    const report = await generateMonthlyOperationReport(own.context, "2026-09", asOf);
    expect(MonthlyReviewFactsV1Schema.parse(report.facts).metrics.real.samples).toHaveLength(0);
  });

  it("can retrieve a selected report older than the latest 50 only within its tenant", async () => {
    const own = await fixture();
    const other = await fixture();
    const base = {
      periodStart: new Date("2026-08-01T00:00:00.000Z"), periodEnd: new Date("2026-09-01T00:00:00.000Z"),
      facts: { legacy: true }, dataLimitations: [], hypotheses: [], recommendations: [], simulated: false,
    };
    const old = await db.operationReport.create({ data: { ...base, clientId: own.client.id, generatedAt: new Date("2026-08-01T00:00:00.000Z") } });
    const foreign = await db.operationReport.create({ data: { ...base, clientId: other.client.id, generatedAt: new Date("2026-08-01T00:00:00.000Z") } });
    await db.operationReport.createMany({ data: Array.from({ length: 50 }, (_, index) => ({
      ...base, clientId: own.client.id, generatedAt: new Date(Date.UTC(2026, 8, index + 1)),
    })) });
    const latest = await db.operationReport.findMany({
      where: { clientId: own.client.id }, orderBy: [{ generatedAt: "desc" }, { id: "desc" }], take: 50,
    });
    expect(latest.some((report) => report.id === old.id)).toBe(false);
    expect(await db.operationReport.findFirst({ where: { id: old.id, clientId: own.client.id } })).toMatchObject({ id: old.id });
    expect(await db.operationReport.findFirst({ where: { id: foreign.id, clientId: own.client.id } })).toBeNull();
    const pageSource = await readFile("src/app/reviews/monthly/page.tsx", "utf8");
    expect(pageSource).toMatch(/selectedId\s*\?\s*db\.operationReport\.findFirst\(\{\s*where:\s*\{\s*id:\s*selectedId,\s*clientId:\s*context\.clientId\s*\}/);
    expect(pageSource).toContain("selectedReport && !reports.some");
  });
});
