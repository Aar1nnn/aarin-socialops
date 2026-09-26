import { ContentStatus, Prisma } from "@prisma/client";
import type { RequestContext } from "@/lib/context";
import { db } from "@/lib/db";

export const contentLanes = [
  { key: "all", label: "全部", statuses: null },
  { key: "draft", label: "草稿", statuses: [ContentStatus.DRAFT, ContentStatus.CHANGES_REQUESTED] },
  { key: "review", label: "待人工审核", statuses: [ContentStatus.REVIEW_PENDING] },
  { key: "approved", label: "已批准", statuses: [ContentStatus.APPROVED] },
  { key: "scheduled", label: "已排期", statuses: [ContentStatus.SCHEDULED, ContentStatus.RUNNING] },
  { key: "published", label: "已发布", statuses: [ContentStatus.PUBLISHED] },
  { key: "attention", label: "需处理", statuses: [ContentStatus.CHANGES_REQUESTED, ContentStatus.WAITING_CONFIGURATION, ContentStatus.FAILED, ContentStatus.UNKNOWN] },
] as const;

export type ContentSearch = { q?: string; status?: string; platform?: string; accountId?: string; productId?: string };

export async function listContentOperations(context: RequestContext, filters: ContentSearch) {
  const lane = contentLanes.find((entry) => entry.key === filters.status) ?? contentLanes[0];
  const q = filters.q?.trim().slice(0, 120) || "";
  const where: Prisma.ContentItemWhereInput = {
    clientId: context.clientId,
    ...(lane.statuses ? { status: { in: [...lane.statuses] } } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.productId ? { plan: { productId: filters.productId } } : {}),
    ...(q ? { OR: [
      { plan: { theme: { contains: q, mode: "insensitive" } } },
      { plan: { product: { name: { contains: q, mode: "insensitive" } } } },
      { currentVersion: { title: { contains: q, mode: "insensitive" } } },
      { currentVersion: { text: { contains: q, mode: "insensitive" } } },
      { account: { displayName: { contains: q, mode: "insensitive" } } },
    ] } : {}),
  };
  const [items, total, products, filterAccounts, client] = await Promise.all([
    db.contentItem.findMany({
      where,
      take: 100,
      orderBy: { updatedAt: "desc" },
      include: {
        plan: { select: { theme: true, product: { select: { id: true, name: true } } } },
        account: { select: { id: true, displayName: true, publishCapability: true } },
        currentVersion: { select: { id: true, version: true, title: true, text: true, approvals: { orderBy: { createdAt: "desc" }, take: 1, select: { decision: true, accountId: true } }, publishJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } } } },
      },
    }),
    db.contentItem.count({ where }),
    db.product.findMany({ where: { clientId: context.clientId }, orderBy: { updatedAt: "desc" }, select: { id: true, name: true, fields: { select: { status: true, value: true } } } }),
    db.socialAccount.findMany({ where: { clientId: context.clientId }, orderBy: [{ platform: "asc" }, { displayName: "asc" }], select: { id: true, platform: true, displayName: true, publishCapability: true, isSelected: true } }),
    db.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { name: true, mode: true, timezone: true } }),
  ]);
  return { items, total, products, filterAccounts, accounts: filterAccounts.filter((account) => account.isSelected), client, lane, q };
}

export async function getContentOperationsDetail(context: RequestContext, id: string) {
  return db.contentItem.findFirst({
    where: { id, clientId: context.clientId },
    include: {
      account: { select: { id: true, displayName: true, publishCapability: true, isSelected: true } },
      plan: { include: { product: { include: { fields: true } }, items: { select: { id: true, platform: true, account: { select: { displayName: true } }, currentVersion: { select: { version: true } } } } } },
      currentVersion: { include: { assetLinks: { include: { asset: { select: { id: true, originalName: true, kind: true } } } }, approvals: { orderBy: { createdAt: "desc" }, include: { reviewer: { select: { displayName: true } } } } } },
      versions: { orderBy: { version: "desc" }, include: { createdBy: { select: { displayName: true } }, approvals: { orderBy: { createdAt: "desc" }, include: { reviewer: { select: { displayName: true } } } }, reviewComments: { orderBy: { createdAt: "desc" }, include: { reviewer: { select: { displayName: true } } } }, publishJobs: { orderBy: { createdAt: "desc" } } } },
    },
  });
}
