import type { DataKind } from "@prisma/client";
import { db } from "../lib/db";
import type { RequestContext } from "../lib/context";
import { buildBrandContext } from "./brand-service";
import { canonicalMetricKey, metricSnapshotScopeKey } from "./analytics-service";

const defaultLimit = 12;

function firstMeaningfulLine(text: string): string {
  return text.split(/\r?\n|(?<=[.!?。！？])\s+/).map((part) => part.trim()).find(Boolean) || text.trim();
}

function likelyCta(text: string): string | null {
  const parts = text.split(/\r?\n|(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
  const action = [...parts].reverse().find((part) => /\b(contact|learn|discover|request|shop|message|download|visit)\b|联系|咨询|了解|获取|私信|下载/i.test(part));
  return action || null;
}

export async function buildContentMemory(context: RequestContext, limit = defaultLimit) {
  const items = await db.contentItem.findMany({
    where: { clientId: context.clientId, currentVersionId: { not: null } },
    include: {
      account: { select: { platform: true } },
      plan: { include: { product: { select: { id: true, name: true } } } },
      currentVersion: { select: { id: true, text: true, createdAt: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return {
    recentPosts: items.map((item) => ({
      contentItemId: item.id,
      contentVersionId: item.currentVersion!.id,
      theme: item.plan.theme,
      hook: firstMeaningfulLine(item.currentVersion!.text),
      cta: likelyCta(item.currentVersion!.text),
      product: item.plan.product ? { id: item.plan.product.id, name: item.plan.product.name } : null,
      platform: item.account.platform,
      publishedOrScheduledAt: item.scheduledAt,
      versionCreatedAt: item.currentVersion!.createdAt,
    })),
    recentThemes: [...new Set(items.map((item) => item.plan.theme))],
    recentHooks: [...new Set(items.map((item) => firstMeaningfulLine(item.currentVersion!.text)))],
    recentCtas: [...new Set(items.map((item) => likelyCta(item.currentVersion!.text)).filter((value): value is string => Boolean(value)))],
    recentProducts: [...new Map(items.filter((item) => item.plan.product).map((item) => [item.plan.product!.id, item.plan.product!.name])).entries()].map(([id, name]) => ({ id, name })),
    recentPlatforms: [...new Set(items.map((item) => item.account.platform))],
  };
}

export async function buildPerformanceMemory(context: RequestContext, since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)) {
  const snapshots = await db.metricSnapshot.findMany({
    where: { clientId: context.clientId, fetchedAt: { gte: since } },
    include: { account: { select: { platform: true, displayName: true } } },
    orderBy: { fetchedAt: "desc" },
    take: 500,
  });
  const latestByScope = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    const scope = metricSnapshotScopeKey({ ...snapshot, account: { platform: snapshot.account.platform } });
    const previous = latestByScope.get(scope);
    if (!previous || snapshot.fetchedAt > previous.fetchedAt) latestByScope.set(scope, snapshot);
  }
  const groups = new Map<string, { metricKey: string; dataKind: DataKind; availableTotal: number | null; availableSamples: number; missingStates: Set<string>; latestFetchedAt: Date; platforms: Set<string> }>();
  for (const snapshot of latestByScope.values()) {
    const metricKey = canonicalMetricKey(snapshot.metricKey);
    const key = `${metricKey}:${snapshot.dataKind}`;
    const group = groups.get(key) || {
      metricKey,
      dataKind: snapshot.dataKind,
      availableTotal: null,
      availableSamples: 0,
      missingStates: new Set<string>(),
      latestFetchedAt: snapshot.fetchedAt,
      platforms: new Set<string>(),
    };
    group.platforms.add(snapshot.account.platform);
    if (snapshot.fetchedAt > group.latestFetchedAt) group.latestFetchedAt = snapshot.fetchedAt;
    if (snapshot.availability === "AVAILABLE" && snapshot.numericValue !== null) {
      group.availableTotal = (group.availableTotal ?? 0) + Number(snapshot.numericValue);
      group.availableSamples += 1;
    } else {
      group.missingStates.add(snapshot.availability);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    metricKey: group.metricKey,
    dataKind: group.dataKind,
    availableTotal: group.availableTotal,
    availableSamples: group.availableSamples,
    missingStates: [...group.missingStates],
    latestFetchedAt: group.latestFetchedAt,
    platforms: [...group.platforms],
  }));
}

export async function buildResearchMemory(context: RequestContext, limit = defaultLimit) {
  const records = await db.researchRecord.findMany({
    where: { clientId: context.clientId },
    orderBy: { observedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return records.map((record) => ({
    id: record.id,
    kind: record.kind,
    objective: record.objective,
    sourceUrl: record.sourceUrl,
    observedAt: record.observedAt,
    observations: record.observations,
    inferences: record.inferences,
    experiments: record.experiments,
    limitations: record.limitations,
  }));
}

export async function buildStructuredMemory(context: RequestContext) {
  const [brand, content, performance, research] = await Promise.all([
    buildBrandContext(context),
    buildContentMemory(context),
    buildPerformanceMemory(context),
    buildResearchMemory(context),
  ]);
  return { brand, content, performance, research };
}
