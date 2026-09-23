import { AssetKind, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

export type MediaAvailability = "LOCAL_ONLY" | "PRIVATE_REMOTE" | "PUBLIC_HTTPS" | "SIGNED_HTTPS" | "UNAVAILABLE";

const assetFilterSchema = z.object({
  query: z.string().trim().max(200).optional(),
  kind: z.nativeEnum(AssetKind).optional(),
  mimeType: z.string().trim().max(200).optional(),
  productId: z.string().min(1).optional(),
  tagIds: z.array(z.string().min(1)).max(20).optional(),
  availability: z.enum(["LOCAL_ONLY", "PRIVATE_REMOTE", "PUBLIC_HTTPS", "SIGNED_HTTPS", "UNAVAILABLE"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const tagAssignmentSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
});

function metadataObject(metadata: Prisma.JsonValue | null): Prisma.JsonObject {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Prisma.JsonObject : {};
}

export function classifyMediaAvailability(asset: {
  storageProvider: string;
  storageKey: string;
  metadata: Prisma.JsonValue | null;
}): MediaAvailability {
  if (!asset.storageKey) return "UNAVAILABLE";
  const metadata = metadataObject(asset.metadata);
  const publicUrl = typeof metadata.publicUrl === "string" ? metadata.publicUrl : null;
  const signedUrl = typeof metadata.signedUrl === "string" ? metadata.signedUrl : null;
  if (publicUrl?.startsWith("https://")) return "PUBLIC_HTTPS";
  if (signedUrl?.startsWith("https://")) return "SIGNED_HTTPS";
  if (asset.storageProvider === "local") return "LOCAL_ONLY";
  return "PRIVATE_REMOTE";
}

function presentAsset<T extends { metadata: Prisma.JsonValue | null; storageProvider: string; storageKey: string }>(asset: T) {
  const metadata = metadataObject(asset.metadata);
  return {
    ...asset,
    filename: "originalName" in asset ? asset.originalName : undefined,
    size: "byteSize" in asset ? asset.byteSize : undefined,
    width: typeof metadata.width === "number" ? metadata.width : null,
    height: typeof metadata.height === "number" ? metadata.height : null,
    duration: typeof metadata.duration === "number" ? metadata.duration : null,
    availability: classifyMediaAvailability(asset),
  };
}

export async function searchAssets(context: RequestContext, raw: unknown = {}) {
  const input = assetFilterSchema.parse(raw);
  const assets = await db.asset.findMany({
    where: {
      clientId: context.clientId,
      ...(input.query ? { originalName: { contains: input.query, mode: "insensitive" } } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.mimeType ? { mimeType: { startsWith: input.mimeType } } : {}),
      ...(input.productId ? { productLinks: { some: { productId: input.productId, clientId: context.clientId } } } : {}),
      ...(input.tagIds?.length ? { tagLinks: { some: { clientId: context.clientId, tagId: { in: input.tagIds } } } } : {}),
    },
    include: {
      tagLinks: { include: { tag: true } },
      productLinks: { include: { product: { select: { id: true, name: true } } } },
      _count: { select: { contentLinks: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: input.limit,
  });
  return assets.map(presentAsset).filter((asset) => !input.availability || asset.availability === input.availability);
}

export async function setAssetTags(context: RequestContext, assetId: string, raw: unknown) {
  assertCanWrite(context);
  const input = tagAssignmentSchema.parse(raw);
  const asset = await db.asset.findFirst({ where: { id: assetId, clientId: context.clientId }, select: { id: true } });
  if (!asset) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
  const names = [...new Set(input.tags.map((name) => name.trim()))];
  return db.$transaction(async (tx) => {
    const tags = [];
    for (const name of names) {
      const normalizedName = name.toLocaleLowerCase("en-US");
      tags.push(await tx.assetTag.upsert({
        where: { clientId_normalizedName: { clientId: context.clientId, normalizedName } },
        update: { name },
        create: { clientId: context.clientId, name, normalizedName },
      }));
    }
    await tx.assetTagLink.deleteMany({ where: { assetId, clientId: context.clientId } });
    if (tags.length) await tx.assetTagLink.createMany({ data: tags.map((tag) => ({ assetId, tagId: tag.id, clientId: context.clientId })) });
    await tx.auditLog.create({
      data: { clientId: context.clientId, userId: context.userId, action: "ASSET_TAGS_UPDATED", entityType: "Asset", entityId: assetId, metadata: { tagIds: tags.map((tag) => tag.id) } },
    });
    return tags;
  });
}

export async function detectDuplicateAsset(context: RequestContext, checksum: string, excludeAssetId?: string) {
  const duplicate = await db.asset.findFirst({
    where: { clientId: context.clientId, checksum, ...(excludeAssetId ? { id: { not: excludeAssetId } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return duplicate ? { duplicate: true as const, asset: presentAsset(duplicate) } : { duplicate: false as const, asset: null };
}

export async function getAssetUsage(context: RequestContext, assetId: string) {
  const asset = await db.asset.findFirst({
    where: { id: assetId, clientId: context.clientId },
    include: {
      productLinks: { where: { clientId: context.clientId }, include: { product: { select: { id: true, name: true } } } },
      contentLinks: {
        where: { clientId: context.clientId },
        include: {
          contentVersion: {
            include: {
              item: { include: { account: { select: { id: true, displayName: true, platform: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!asset) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
  const content = asset.contentLinks.map((link) => ({
    contentVersionId: link.contentVersionId,
    contentItemId: link.contentVersion.contentItemId,
    version: link.contentVersion.version,
    platform: link.contentVersion.item.platform,
    account: link.contentVersion.item.account,
    usedAt: link.createdAt,
  }));
  return {
    asset: presentAsset(asset),
    linkedProducts: asset.productLinks.map((link) => link.product),
    linkedContent: content,
    platformUsage: Object.entries(content.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.platform]: (counts[entry.platform] || 0) + 1 }), {})).map(([platform, count]) => ({ platform, count })),
    recentUsage: content.slice(0, 20),
    usageCount: content.length,
  };
}

export const assetLibrarySchemas = { filter: assetFilterSchema, tags: tagAssignmentSchema };
