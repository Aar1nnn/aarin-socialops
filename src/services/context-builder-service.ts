import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import type { RequestContext } from "../lib/context";
import {
  buildBrandMemory,
  buildContentMemory,
  buildPerformanceMemory,
  buildResearchMemory,
} from "./memory-service";

export async function buildBrandContext(context: RequestContext) {
  return buildBrandMemory(context);
}

export async function buildProductContext(context: RequestContext, productId: string) {
  const product = await db.product.findFirst({
    where: { id: productId, clientId: context.clientId },
    include: { fields: true },
  });
  if (!product) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
  return {
    id: product.id,
    name: product.name,
    modelNumber: product.modelNumber,
    dataVersion: product.dataVersion,
    confirmedFacts: product.fields
      .filter((field) => field.status === "CONFIRMED" && field.value)
      .map((field) => ({ key: field.key, value: field.value!, source: field.source || "未记录来源" })),
    missingFields: product.fields
      .filter((field) => field.status !== "CONFIRMED" || !field.value)
      .map((field) => field.key),
  };
}

export async function buildContentMemoryContext(context: RequestContext, take = 20) {
  return buildContentMemory(context, take);
}

export async function buildPerformanceContext(context: RequestContext, take = 100) {
  return buildPerformanceMemory(context, take);
}

export async function buildResearchContext(context: RequestContext, take = 20) {
  return buildResearchMemory(context, take);
}

export async function buildCompositionContext(context: RequestContext, productId?: string) {
  const [brand, product, recentContent, performance, research] = await Promise.all([
    buildBrandContext(context),
    productId ? buildProductContext(context, productId) : Promise.resolve(null),
    buildContentMemoryContext(context),
    buildPerformanceContext(context),
    buildResearchContext(context),
  ]);
  return { brand, product, recentContent, performance, research };
}
