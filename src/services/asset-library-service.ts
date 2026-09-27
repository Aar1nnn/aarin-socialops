import { AssetKind, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { resolveAssetExternalRead, externalReadDescriptor, type MediaAvailability } from "../lib/adapters/storage";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

export type { MediaAvailability } from "../lib/adapters/storage";

const assetFilterSchema = z.object({
  query: z.string().trim().max(200).optional(),
  kind: z.nativeEnum(AssetKind).optional(),
  mimeType: z.string().trim().max(200).optional(),
  productId: z.string().min(1).optional(),
  tagIds: z.array(z.string().min(1)).max(20).optional(),
  availability: z.enum(["LOCAL_ONLY", "PRIVATE_REMOTE", "PUBLIC_HTTPS", "SIGNED_HTTPS", "UNAVAILABLE"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const assetPageSchema = assetFilterSchema.extend({ cursor: z.string().min(1).optional() });

const tagAssignmentSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  expectedTagIds: z.array(z.string().trim().min(1)).max(50),
});

const assetProductSchema = z.object({ productId: z.string().min(1) });

function normalizeIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.normalize("NFKC").trim()))].sort();
}

function assetWhere(context: RequestContext, input: z.infer<typeof assetFilterSchema>): Prisma.AssetWhereInput {
  return {
    clientId: context.clientId,
    ...(input.query ? { originalName: { contains: input.query, mode: "insensitive" } } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.mimeType ? { mimeType: { startsWith: input.mimeType } } : {}),
    ...(input.productId ? { productLinks: { some: { productId: input.productId, clientId: context.clientId, product: { clientId: context.clientId } } } } : {}),
    ...(input.tagIds?.length ? { tagLinks: { some: { clientId: context.clientId, tagId: { in: input.tagIds }, tag: { clientId: context.clientId } } } } : {}),
  };
}

function listingInclude(clientId: string) {
  return {
    tagLinks: { where: { clientId, tag: { clientId } }, include: { tag: true } },
    productLinks: { where: { clientId, product: { clientId } }, include: { product: { select: { id: true, clientId: true, name: true } } } },
    _count: { select: { contentLinks: { where: { clientId, contentVersion: { clientId, item: { clientId, account: { clientId } } } } } } },
  } as const;
}

type AssetListRecord = Prisma.AssetGetPayload<{ include: ReturnType<typeof listingInclude> }>;
type PresentedAsset = Awaited<ReturnType<typeof presentAsset<AssetListRecord>>>;

function visibleAssetLinks(asset: AssetListRecord, clientId: string): AssetListRecord {
  return {
    ...asset,
    tagLinks: asset.tagLinks.filter((link) => link.clientId === clientId && link.tag.clientId === clientId),
    productLinks: asset.productLinks.filter((link) => link.clientId === clientId && link.product.clientId === clientId),
  };
}

function metadataObject(metadata: Prisma.JsonValue | null): Prisma.JsonObject {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Prisma.JsonObject : {};
}

// Presentation never returns arbitrary stored metadata. In particular, URL and
// credential candidates are only used by the resolver and must not leave it.
function publicMetadata(metadata: Prisma.JsonObject): Prisma.JsonObject {
  const output: Prisma.JsonObject = {};
  for (const key of ["width", "height", "duration", "durationSeconds"]) {
    if (typeof metadata[key] === "number" && Number.isFinite(metadata[key])) output[key] = metadata[key];
  }
  const inspection = metadataObject(metadata.inspection ?? null);
  if (Object.keys(inspection).length) {
    const safeInspection: Prisma.JsonObject = {};
    for (const key of ["width", "height", "durationSeconds", "fps", "bitrate"]) {
      if (typeof inspection[key] === "number" && Number.isFinite(inspection[key])) safeInspection[key] = inspection[key];
    }
    if (["AVAILABLE", "UNAVAILABLE", "FAILED"].includes(String(inspection.status))) safeInspection.status = inspection.status;
    if (["ffprobe", "magic-bytes"].includes(String(inspection.source))) safeInspection.source = inspection.source;
    for (const key of ["videoCodec", "audioCodec", "container", "errorCode"]) {
      if (typeof inspection[key] === "string" && /^[A-Za-z0-9_,.+-]{1,100}$/.test(inspection[key])) safeInspection[key] = inspection[key];
    }
    output.inspection = safeInspection;
  }
  return output;
}

export async function classifyMediaAvailability(asset: {
  storageProvider: string;
  storageKey: string;
  metadata: Prisma.JsonValue | null;
}): Promise<MediaAvailability> {
  return (await resolveAssetExternalRead(asset)).availability;
}

async function presentAsset<T extends { metadata: Prisma.JsonValue | null; storageProvider: string; storageKey: string }>(asset: T, now = new Date()) {
  const metadata = metadataObject(asset.metadata);
  const inspection = metadataObject(metadata.inspection ?? null);
  const externalRead = await resolveAssetExternalRead(asset, { now });
  return {
    ...asset,
    metadata: publicMetadata(metadata),
    filename: "originalName" in asset ? asset.originalName : undefined,
    size: "byteSize" in asset ? asset.byteSize : undefined,
    width: typeof inspection.width === "number" ? inspection.width : typeof metadata.width === "number" ? metadata.width : null,
    height: typeof inspection.height === "number" ? inspection.height : typeof metadata.height === "number" ? metadata.height : null,
    duration: typeof inspection.durationSeconds === "number" ? inspection.durationSeconds : typeof metadata.duration === "number" ? metadata.duration : null,
    availability: externalRead.availability,
    externalRead: externalReadDescriptor(externalRead),
  };
}

export async function searchAssets(context: RequestContext, raw: unknown = {}) {
  const input = assetFilterSchema.parse(raw);
  const where = assetWhere(context, input);
  const orderBy = [{ createdAt: "desc" as const }, { id: "asc" as const }];
  const assessedAt = new Date();
  if (!input.availability) {
    const assets = await db.asset.findMany({ where, include: listingInclude(context.clientId), orderBy, take: input.limit });
    return Promise.all(assets.map((asset) => presentAsset(visibleAssetLinks(asset, context.clientId), assessedAt)));
  }

  const results = [];
  const batchSize = Math.max(50, input.limit);
  let cursor: string | undefined;
  while (results.length < input.limit) {
    const batch = await db.asset.findMany({
      where,
      include: listingInclude(context.clientId),
      orderBy,
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const presentedBatch = await Promise.all(batch.map((asset) => presentAsset(visibleAssetLinks(asset, context.clientId), assessedAt)));
    for (const presented of presentedBatch) {
      if (presented.availability === input.availability) results.push(presented);
      if (results.length === input.limit) break;
    }
    if (batch.length < batchSize) break;
    cursor = batch.at(-1)?.id;
    if (!cursor) break;
  }
  return results;
}

// Availability is a runtime classification. The cursor advances over the last
// database row examined, including rows that did not match the classification.
export async function listAssetLibraryPage(context: RequestContext, raw: unknown = {}) {
  const input = assetPageSchema.parse(raw);
  const baseWhere = assetWhere(context, input);
  const cursorAsset = input.cursor ? await db.asset.findFirst({
    where: { id: input.cursor, clientId: context.clientId },
    select: { id: true, createdAt: true },
  }) : null;
  if (input.cursor && !cursorAsset) throw new AppError("素材分页位置已失效，请重新筛选。", 400, "ASSET_CURSOR_INVALID");

  const assessedAt = new Date();
  const items: PresentedAsset[] = [];
  const batchSize = Math.min(100, Math.max(25, input.limit * 2));
  const maxScanned = Math.max(200, input.limit * 5);
  let position = cursorAsset;
  let scanned = 0;
  let reachedEnd = false;
  let unscannedInBatch = false;

  while (items.length < input.limit && scanned < maxScanned) {
    const where: Prisma.AssetWhereInput = {
      ...baseWhere,
      ...(position ? { OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { gt: position.id } }] } : {}),
    };
    const batch = await db.asset.findMany({ where, include: listingInclude(context.clientId), orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: Math.min(batchSize, maxScanned - scanned) });
    if (!batch.length) { reachedEnd = true; break; }
    for (let index = 0; index < batch.length; index += 1) {
      const asset = batch[index];
      position = { id: asset.id, createdAt: asset.createdAt };
      scanned += 1;
      const presented = await presentAsset(visibleAssetLinks(asset, context.clientId), assessedAt);
      if (!input.availability || presented.availability === input.availability) items.push(presented);
      if (items.length === input.limit || scanned === maxScanned) {
        unscannedInBatch = index + 1 < batch.length;
        break;
      }
    }
    if (items.length === input.limit || scanned === maxScanned) break;
    if (batch.length < batchSize) { reachedEnd = true; break; }
  }

  let hasMore = unscannedInBatch;
  if (!hasMore && !reachedEnd && position) {
    hasMore = Boolean(await db.asset.findFirst({
      where: { ...baseWhere, OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { gt: position.id } }] },
      select: { id: true },
    }));
  }
  return { items, nextCursor: hasMore ? position?.id ?? null : null, scanned };
}

export async function setAssetTags(context: RequestContext, assetId: string, raw: unknown) {
  assertCanWrite(context);
  const parsed = tagAssignmentSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("素材标签请求无效，请刷新后提交标签和预期标签集合。", 400, "ASSET_TAG_INPUT_INVALID");
  const input = parsed.data;
  const names = [...new Map(input.tags.map((name) => [name.trim().toLocaleLowerCase("en-US"), name.trim()])).values()];
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Asset" WHERE "id" = ${assetId} AND "clientId" = ${context.clientId} FOR UPDATE`;
    if (!locked.length) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
    const current = await tx.assetTagLink.findMany({ where: { assetId, clientId: context.clientId }, select: { tagId: true } });
    if (JSON.stringify(normalizeIds(current.map((link) => link.tagId))) !== JSON.stringify(normalizeIds(input.expectedTagIds))) {
      throw new AppError("素材标签已被其他人修改，请刷新后重试。", 409, "ASSET_TAG_CONFLICT");
    }
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

export async function attachAssetToProduct(context: RequestContext, assetId: string, raw: unknown) {
  assertCanWrite(context);
  const { productId } = assetProductSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Asset" WHERE "id" = ${assetId} AND "clientId" = ${context.clientId} FOR UPDATE`;
    if (!locked.length) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
    const lockedProduct = await tx.$queryRaw<Array<{ id: string; name: string }>>`SELECT "id", "name" FROM "Product" WHERE "id" = ${productId} AND "clientId" = ${context.clientId} FOR UPDATE`;
    const product = lockedProduct[0];
    if (!product) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
    const existing = await tx.productAsset.findUnique({ where: { productId_assetId: { productId, assetId } }, select: { clientId: true } });
    if (existing) {
      if (existing.clientId !== context.clientId) throw new AppError("产品关联租户不匹配。", 409, "ASSET_PRODUCT_CONFLICT");
      return { linked: false, product };
    }
    await tx.productAsset.create({ data: { clientId: context.clientId, productId, assetId } });
    await tx.auditLog.create({ data: {
      clientId: context.clientId, userId: context.userId, action: "ASSET_PRODUCT_LINKED", entityType: "Asset", entityId: assetId,
      metadata: { productId },
    } });
    return { linked: true, product };
  });
}

export async function detectDuplicateAsset(context: RequestContext, checksum: string, excludeAssetId?: string) {
  const duplicate = await db.asset.findFirst({
    where: { clientId: context.clientId, checksum, ...(excludeAssetId ? { id: { not: excludeAssetId } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return duplicate ? { duplicate: true as const, asset: await presentAsset(duplicate) } : { duplicate: false as const, asset: null };
}

export async function getAssetUsage(context: RequestContext, assetId: string, options: { recentOnly?: boolean } = {}) {
  const asset = await db.asset.findFirst({
    where: { id: assetId, clientId: context.clientId },
    include: {
      tagLinks: { where: { clientId: context.clientId, tag: { clientId: context.clientId } }, include: { tag: true } },
      productLinks: { where: { clientId: context.clientId, product: { clientId: context.clientId } }, include: { product: { select: { id: true, name: true } } } },
      contentLinks: {
        where: { clientId: context.clientId, contentVersion: { clientId: context.clientId, item: { clientId: context.clientId, account: { clientId: context.clientId } } } },
        include: {
          contentVersion: {
            include: {
              item: { include: { account: { select: { id: true, displayName: true, platform: true } } } },
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { contentVersionId: "asc" }],
        ...(options.recentOnly ? { take: 20 } : {}),
      },
    },
  });
  if (!asset) throw new AppError("素材不存在或无权访问。", 404, "ASSET_NOT_FOUND");
  const counts = await db.$queryRaw<Array<{ platform: string; count: bigint }>>`
    SELECT item."platform" AS "platform", COUNT(*)::bigint AS "count"
    FROM "ContentVersionAsset" AS link
    JOIN "ContentVersion" AS version ON version."id" = link."contentVersionId"
    JOIN "ContentItem" AS item ON item."id" = version."contentItemId"
    JOIN "SocialAccount" AS account ON account."id" = item."accountId"
    WHERE link."assetId" = ${assetId} AND link."clientId" = ${context.clientId}
      AND version."clientId" = ${context.clientId} AND item."clientId" = ${context.clientId}
      AND account."clientId" = ${context.clientId}
    GROUP BY item."platform" ORDER BY item."platform" ASC
  `;
  const content = asset.contentLinks.map((link) => ({
    contentVersionId: link.contentVersionId,
    contentItemId: link.contentVersion.contentItemId,
    version: link.contentVersion.version,
    platform: link.contentVersion.item.platform,
    account: link.contentVersion.item.account,
    usedAt: link.createdAt,
  }));
  return {
    asset: await presentAsset(asset),
    linkedProducts: asset.productLinks.map((link) => link.product),
    linkedContent: content,
    platformUsage: counts.map(({ platform, count }) => ({ platform, count: Number(count) })),
    recentUsage: content.slice(0, 20),
    usageCount: counts.reduce((sum, entry) => sum + Number(entry.count), 0),
  };
}

export const assetLibrarySchemas = { filter: assetFilterSchema, page: assetPageSchema, tags: tagAssignmentSchema, product: assetProductSchema };
