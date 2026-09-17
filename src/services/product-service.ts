import { AssetKind, ContentStatus, FactStatus, Prisma, PublishJobStatus } from "@prisma/client";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { createProductSchema } from "../lib/contracts";
import { storeLocalAsset } from "../lib/adapters/storage";
import { assertCanWrite, type RequestContext } from "../lib/context";

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
  const product = input.productId
    ? await db.product.findFirst({ where: { id: input.productId, clientId: context.clientId } })
    : null;
  if (input.productId && !product) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
  const stored = await storeLocalAsset(context.clientId, input.file);
  const kind = stored.mimeType.startsWith("image/")
    ? AssetKind.IMAGE
    : stored.mimeType.startsWith("video/")
      ? AssetKind.VIDEO
      : AssetKind.DOCUMENT;
  if (kind === AssetKind.DOCUMENT) {
    throw new AppError("第一阶段只接受图片和已剪辑视频。", 400, "UNSUPPORTED_ASSET_TYPE");
  }
  try {
    return await db.asset.create({
      data: {
        clientId: context.clientId,
        kind,
        originalName: input.file.name,
        ...stored,
        productLinks: product
          ? { create: { clientId: context.clientId, productId: product.id } }
          : undefined,
      },
      include: { productLinks: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("同一素材已上传。", 409, "DUPLICATE_ASSET");
    }
    throw error;
  }
}

export async function updateProductFacts(context: RequestContext, productId: string, raw: unknown) {
  assertCanWrite(context);
  const input = createProductSchema.parse(raw);
  const product = await db.product.findFirst({ where: { id: productId, clientId: context.clientId } });
  if (!product) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT item."id" FROM "ContentItem" AS item
      INNER JOIN "ContentPlan" AS plan ON plan."id" = item."planId"
      WHERE plan."productId" = ${productId} AND item."clientId" = ${context.clientId}
      FOR UPDATE OF item
    `;
    const running = await tx.contentItem.count({ where: { clientId: context.clientId, plan: { productId }, status: ContentStatus.RUNNING } });
    if (running > 0) throw new AppError("关联内容正在发布，不能修改产品事实；请等待发布结果或先完成对账。", 409, "PUBLISH_IN_PROGRESS");
    for (const field of input.fields) {
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
    const updated = await tx.product.update({
      where: { id: productId },
      data: {
        name: input.name,
        modelNumber: input.modelNumber || null,
        dataVersion: { increment: 1 },
        status: input.fields.some((field) => field.status === "CONFIRMED") ? "CONFIRMED" : "PROPOSED",
      },
      include: { fields: true },
    });
    const invalidatedItems = await tx.contentItem.updateMany({
      where: {
        clientId: context.clientId,
        plan: { productId },
        status: { notIn: [ContentStatus.PUBLISHED, ContentStatus.CANCELLED] },
      },
      data: { status: ContentStatus.CHANGES_REQUESTED },
    });
    const cancelledJobs = await tx.publishJob.updateMany({
      where: {
        clientId: context.clientId,
        contentVersion: { item: { plan: { productId } } },
        status: { in: [PublishJobStatus.PENDING, PublishJobStatus.RETRY, PublishJobStatus.WAITING_CONFIGURATION] },
      },
      data: { status: PublishJobStatus.CANCELLED, lastErrorCode: "PRODUCT_FACTS_CHANGED", lastErrorMessage: "产品资料版本已更新，内容需要重新生成或编辑并审核。" },
    });
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
