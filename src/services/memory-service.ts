import type { Prisma } from "@prisma/client";
import { db } from "../lib/db";
import type { RequestContext } from "../lib/context";
import { getBrandProfile } from "./brand-service";

export type ContentMemoryEntry = {
  contentItemId: string;
  platform: string;
  theme: string;
  title: string | null;
  hook: string;
  cta: string | null;
  product: string | null;
  status: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
};

export type PerformanceMemoryEntry = {
  metricKey: string;
  platform: string;
  accountId: string;
  availability: string;
  dataKind: string;
  value: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  fetchedAt: Date;
};

function firstSentence(text: string) {
  return text.split(/(?<=[.!?。！？])\s+/u)[0]?.slice(0, 240) || text.slice(0, 240);
}

function lastSentence(text: string) {
  const sentences = text.split(/(?<=[.!?。！？])\s+/u).filter(Boolean);
  return sentences.at(-1)?.slice(0, 240) || null;
}

export async function buildBrandMemory(context: RequestContext) {
  return getBrandProfile(context);
}

export async function buildContentMemory(context: RequestContext, take = 20): Promise<ContentMemoryEntry[]> {
  const items = await db.contentItem.findMany({
    where: { clientId: context.clientId, currentVersionId: { not: null } },
    include: {
      plan: { include: { product: true } },
      currentVersion: { include: { publishJobs: { where: { status: "PUBLISHED" }, orderBy: { publishedAt: "desc" }, take: 1 } } },
    },
    orderBy: { updatedAt: "desc" },
    take,
  });
  return items.flatMap((item) => item.currentVersion ? [{
    contentItemId: item.id,
    platform: item.platform,
    theme: item.plan.theme,
    title: item.currentVersion.title,
    hook: firstSentence(item.currentVersion.text),
    cta: lastSentence(item.currentVersion.text),
    product: item.plan.product?.name || null,
    status: item.status,
    scheduledAt: item.scheduledAt,
    publishedAt: item.currentVersion.publishJobs[0]?.publishedAt || null,
  }] : []);
}

export async function buildPerformanceMemory(context: RequestContext, take = 100): Promise<PerformanceMemoryEntry[]> {
  const snapshots = await db.metricSnapshot.findMany({
    where: { clientId: context.clientId },
    include: { account: { select: { platform: true } } },
    orderBy: { fetchedAt: "desc" },
    take,
  });
  return snapshots.map((snapshot) => ({
    metricKey: snapshot.metricKey,
    platform: snapshot.account.platform,
    accountId: snapshot.accountId,
    availability: snapshot.availability,
    dataKind: snapshot.dataKind,
    value: snapshot.availability === "AVAILABLE" ? snapshot.numericValue?.toString() ?? null : null,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    fetchedAt: snapshot.fetchedAt,
  }));
}

export async function buildResearchMemory(context: RequestContext, take = 20) {
  return db.researchRecord.findMany({
    where: { clientId: context.clientId },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
    take,
    select: {
      id: true,
      kind: true,
      objective: true,
      sourceUrl: true,
      observedAt: true,
      observations: true,
      inferences: true,
      experiments: true,
      limitations: true,
    },
  });
}

export async function buildContentEngineMemory(context: RequestContext) {
  const [brand, recentContent, performance, research] = await Promise.all([
    buildBrandMemory(context),
    buildContentMemory(context),
    buildPerformanceMemory(context),
    buildResearchMemory(context),
  ]);
  return { brand, recentContent, performance, research } satisfies Prisma.JsonObject | Record<string, unknown>;
}
