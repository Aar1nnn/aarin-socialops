import { AssetKind, ContentStatus, FactStatus, Prisma, PublishJobStatus } from "@prisma/client";
import { db } from "../lib/db";
import { MUTABLE_SCHEDULED_JOB_STATUSES } from "../lib/publishing-status";
import { cancelManualTasksForProduct } from "./manual-task-lifecycle";
import { AppError } from "../lib/errors";
import { createProductSchema } from "../lib/contracts";
import { getStorageAdapter, storeAsset } from "../lib/adapters/storage";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { inspectVideo } from "../lib/media-inspector";
import { z } from "zod";

const expectedDataVersionSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9]\d*$/).transform(Number),
]).refine(Number.isSafeInteger);

export async function createProduct(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = createProductSchema.parse(raw);
  const product = await db.product.create({
    data: {
      clientId: context.clientId,
      name: input.name,
      modelNumber: input.modelNumber || null,
      status: input.fields.some((field) => field.status === "CONFIRMED")
        ? FactStatus.CONFIRMED
        : FactStatus.PROPOSED,
      fields: {
        create: input.fields.map((field) => ({
          clientId: context.clientId,
          key: field.key,
          value: field.value || null,
          status: field.status,
          source: field.source || null,
        })),
      },
    },
    include: { fields: true },
  });
  await db.auditLog.create({
    data: {
      clientId: context.clientId,
      userId: context.userId,
      action: "PRODUCT_CREATED",
      entityType: "Product",
      entityId: product.id,
    },
  });
  return product;
}

export async function uploadAsset(
  context: RequestContext,
  input: { file: File; productId?: string },
) {
  assertCanWrite(context);
  if (input.productId && !await db.product.findFirst({ where: { id: input.productId, clientId: context.clientId }, select: { id: true } })) {
    throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
  }
  const stored = await storeAsset(context.clientId, input.file);
  const kind = stored.mimeType.startsWith("image/")
    ? AssetKind.IMAGE
    : stored.mimeType.startsWith("video/")
      ? AssetKind.VIDEO
      : AssetKind.DOCUMENT;
  if (kind === AssetKind.DOCUMENT) {
    await getStorageAdapter(stored.storageProvider).delete(stored.storageKey).catch(() => undefined);
    throw new AppError("第一阶段只接受图片和已剪辑视频。", 400, "UNSUPPORTED_ASSET_TYPE");
  }
  try {
    const inspection = kind === AssetKind.VIDEO
      ? await inspectVideo(stored.storageProvider, stored.storageKey)
      : { status: "AVAILABLE", source: "magic-bytes" };
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${context.clientId} FOR UPDATE`;
      if (input.productId && !await tx.product.findFirst({ where: { id: input.productId, clientId: context.clientId }, select: { id: true } })) {
        throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
      }
      const duplicate = await tx.asset.findFirst({
        where: { clientId: context.clientId, checksum: stored.checksum },
        select: { id: true },
      });
      if (duplicate) throw new AppError(`同一素材已存在（${duplicate.id}）。`, 409, "DUPLICATE_ASSET");
      return tx.asset.create({
        data: {
          clientId: context.clientId,
          kind,
          originalName: input.file.name,
          ...stored,
          metadata: { inspection },
          productLinks: input.productId
            ? { create: { clientId: context.clientId, productId: input.productId } }
            : undefined,
        },
        include: { productLinks: true },
      });
    });
  } catch (error) {
    // The transaction may have committed even if its response was lost. Preserve
    // any object now referenced by an Asset, and preserve it if the check fails.
    let referenced: boolean;
    try {
      referenced = Boolean(await db.asset.findFirst({
        where: { storageProvider: stored.storageProvider, storageKey: stored.storageKey },
        select: { id: true },
      }));
    } catch {
      console.warn("Asset upload outcome could not be verified; retaining stored object for reconciliation.");
      throw error;
    }
    if (!referenced) {
      await getStorageAdapter(stored.storageProvider).delete(stored.storageKey)
        .catch(() => console.warn("Unreferenced uploaded object could not be removed."));
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("同一素材已上传。", 409, "DUPLICATE_ASSET");
    }
    throw error;
  }
}

export async function updateProductFacts(context: RequestContext, productId: string, raw: unknown) {
  assertCanWrite(context);
  const versionRaw = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).expectedDataVersion : undefined;
  const version = expectedDataVersionSchema.safeParse(versionRaw);
  if (!version.success) throw new AppError("产品资料版本无效，请刷新详情页面后重试。", 400, "INVALID_EXPECTED_DATA_VERSION");
  const input = createProductSchema.parse(raw);
  if (new Set(input.fields.map((field) => field.key)).size !== input.fields.length) {
    throw new AppError("产品事实字段不能重复。", 400, "DUPLICATE_PRODUCT_FIELD");
  }
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Product" WHERE "id" = ${productId} AND "clientId" = ${context.clientId} FOR UPDATE`;
    if (!locked.length) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: { fields: true } });
    if (product.fields.some((field) => field.clientId !== context.clientId)) {
      throw new AppError("产品事实关联的客户范围不一致，请先核查数据。", 409, "TENANT_SCOPE_MISMATCH");
    }
    if (product.dataVersion !== version.data) {
      throw new AppError("产品资料已被其他人更新，请刷新后再编辑。", 409, "PRODUCT_VERSION_CONFLICT");
    }
    const changedFields = input.fields.filter((field) => {
      const current = product.fields.find((entry) => entry.key === field.key);
      return !current || current.value !== (field.value || null) || current.status !== field.status || current.source !== (field.source || null);
    });
    if (product.name === input.name && product.modelNumber === (input.modelNumber || null) && changedFields.length === 0) return product;
    await tx.$queryRaw`
      SELECT item."id" FROM "ContentItem" AS item
      INNER JOIN "ContentPlan" AS plan ON plan."id" = item."planId"
      WHERE plan."productId" = ${productId} AND item."clientId" = ${context.clientId}
      FOR UPDATE OF item
    `;
    const running = await tx.contentItem.count({ where: { clientId: context.clientId, plan: { productId }, status: ContentStatus.RUNNING } });
    const runningJob = await tx.publishJob.count({ where: { clientId: context.clientId, status: PublishJobStatus.RUNNING, contentVersion: { item: { plan: { productId } } } } });
    if (running > 0 || runningJob > 0) throw new AppError("关联内容正在发布，不能修改产品事实；请等待发布结果或先完成对账。", 409, "PUBLISH_IN_PROGRESS");
    const unresolved = await tx.publishJob.findFirst({
      where: { clientId: context.clientId, status: PublishJobStatus.UNKNOWN, contentVersion: { item: { plan: { productId } } } },
      select: { adapter: true },
    });
    if (unresolved) throw new AppError("关联发布结果仍不确定；先核实外部平台并在发布中心对账。", 409,
      unresolved.adapter === "manual" ? "MANUAL_RECONCILIATION_REQUIRED" : "PUBLISH_RECONCILIATION_REQUIRED");
    for (const field of changedFields) {
      await tx.productField.upsert({
        where: { productId_key: { productId, key: field.key } },
        update: {
          value: field.value || null,
          status: field.status,
          source: field.source || null,
        },
        create: {
          clientId: context.clientId,
          productId,
          key: field.key,
          value: field.value || null,
          status: field.status,
          source: field.source || null,
        },
      });
    }
    const mergedFields = [...product.fields.filter((field) => !input.fields.some((incoming) => incoming.key === field.key)), ...input.fields];
    const updated = await tx.product.update({
      where: { id: productId },
      data: {
        name: input.name,
        modelNumber: input.modelNumber || null,
        dataVersion: { increment: 1 },
        status: mergedFields.some((field) => field.status === "CONFIRMED") ? "CONFIRMED" : "PROPOSED",
      },
      include: { fields: true },
    });
    const invalidatedItems = await tx.contentItem.updateMany({
      where: {
        clientId: context.clientId,
        plan: { productId },
        status: { notIn: [ContentStatus.PUBLISHED, ContentStatus.CANCELLED] },
      },
      data: { status: ContentStatus.CHANGES_REQUESTED, scheduledAt: null },
    });
    const cancelledJobs = await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersion: { item: { plan: { productId } } },
        status: { in: MUTABLE_SCHEDULED_JOB_STATUSES },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "PRODUCT_FACTS_CHANGED", lastErrorMessage: "产品资料版本已更新，内容需要重新生成或编辑并审核。" },
    });
    await cancelManualTasksForProduct(tx, context.clientId, productId);
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "PRODUCT_FACTS_UPDATED",
        entityType: "Product",
        entityId: productId,
        metadata: { dataVersion: updated.dataVersion, invalidatedContentItems: invalidatedItems.count, cancelledPublishJobs: cancelledJobs.count },
      },
    });
    return updated;
  });
}
