import { Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { resolveAccountPublishingMode } from "../lib/manual-account";
import { strategyModelContext, strategyProvenanceFacts } from "./social-strategy-service";

const manualContentSchema = z.object({
  accountId: z.string().min(1),
  productId: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  theme: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1).max(500),
  title: z.string().trim().max(200).optional(),
  text: z.string().trim().min(1).max(100_000),
  assetIds: z.array(z.string().min(1)).max(100).default([]),
});

export async function createManualContent(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = manualContentSchema.parse(raw);
  const assetIds = [...new Set(input.assetIds)];
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${context.clientId} FOR UPDATE`;
    const [client, account, product, assets, strategy] = await Promise.all([
      tx.client.findUniqueOrThrow({ where: { id: context.clientId } }),
      tx.socialAccount.findFirst({ where: { id: input.accountId, clientId: context.clientId } }),
      input.productId ? tx.product.findFirst({ where: { id: input.productId, clientId: context.clientId }, include: { fields: true } }) : Promise.resolve(null),
      tx.asset.findMany({ where: { id: { in: assetIds }, clientId: context.clientId }, include: { productLinks: true } }),
      tx.socialStrategy.findFirst({ where: { clientId: context.clientId, status: "CONFIRMED" } }),
    ]);
    if (!account || resolveAccountPublishingMode(account) !== "MANUAL" || !account.isSelected) {
      throw new AppError("请选择当前客户已启用的人工管理账号。", 409, "MANUAL_ACCOUNT_REQUIRED");
    }
    if (input.productId && !product) throw new AppError("产品不存在或无权访问。", 404, "PRODUCT_NOT_FOUND");
    if (assets.length !== assetIds.length) throw new AppError("素材不存在或无权访问。", 403, "ASSET_SCOPE_VIOLATION");
    if (product && assets.some((asset) => !asset.productLinks.some((link) => link.productId === product.id))) {
      throw new AppError("所选素材未关联当前产品。", 409, "ASSET_PRODUCT_MISMATCH");
    }
    const confirmedFacts = product?.fields.filter((field) => field.status === "CONFIRMED" && field.value)
      .map((field) => ({ key: field.key, value: field.value!, source: field.source || "未记录来源" })) ?? [];
    const provenance = strategyProvenanceFacts(strategy
      ? { strategy, provenance: "CONFIRMED_BINDING" }
      : { strategy: null, provenance: "UNBOUND_FALLBACK" });
    const targetMarkets = strategy
      ? strategyModelContext({ strategy, provenance: "CONFIRMED_BINDING" })?.targetMarkets ?? client.targetMarkets
      : client.targetMarkets;
    const plan = await tx.contentPlan.create({
      data: {
        clientId: context.clientId,
        productId: product?.id ?? null,
        socialStrategyId: strategy?.id ?? null,
        theme: input.theme,
        objective: input.objective,
        channels: [account.platform],
        marketScope: targetMarkets.length ? targetMarkets.join(", ") : null,
        isGenericDraft: targetMarkets.length === 0,
      },
    });
    const item = await tx.contentItem.create({
      data: { clientId: context.clientId, planId: plan.id, accountId: account.id, platform: account.platform, status: "DRAFT" },
    });
    const version = await tx.contentVersion.create({
      data: {
        clientId: context.clientId,
        contentItemId: item.id,
        version: 1,
        title: input.title || null,
        text: input.text,
        productDataVersion: product?.dataVersion ?? null,
        promptVersionId: null,
        generator: "operator-entry",
        simulated: false,
        generationLabel: "人工创建",
        source: "MANUAL",
        reason: "MANUAL_INITIAL",
        createdByUserId: context.userId,
        sourceFacts: { confirmedFacts, productId: product?.id ?? null, creationMethod: "MANUAL", ...provenance } as Prisma.InputJsonValue,
        assetLinks: { create: assetIds.map((assetId) => ({ clientId: context.clientId, assetId })) },
      },
    });
    await tx.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
    await tx.auditLog.create({
      data: { clientId: context.clientId, userId: context.userId, action: "MANUAL_CONTENT_CREATED", entityType: "ContentItem", entityId: item.id, metadata: { accountId: account.id, contentVersionId: version.id, ...provenance } },
    });
    return { plan, item, version };
  });
}
