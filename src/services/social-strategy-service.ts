import { ClientMode, Prisma, SocialStrategyStatus, type SocialStrategy } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

const text = z.string().trim().max(4000);
const shortText = z.string().trim().max(300);
const list = z.array(shortText.min(1)).max(50).default([]);
const percentage = z.number().int().min(0).max(100);
const weightedChoice = z.object({ name: shortText.min(1), percentage }).strict();
const platform = z.enum(["facebook", "instagram", "tiktok", "linkedin"]);

export const socialStrategyPayloadSchema = z.object({
  businessGoal: text.default(""),
  primaryBuyer: text.default(""),
  targetMarkets: list,
  platformRoles: z.array(z.object({ platform, role: shortText.min(1) }).strict()).max(4).default([]),
  contentPillars: z.array(weightedChoice).max(20).default([]),
  formatMix: z.array(weightedChoice).max(20).default([]),
  postingCadence: text.default(""),
  coreMessage: text.default(""),
  ctaGuidance: list,
  priorityProducts: list,
  assetPriorities: list,
  experiments: list,
  limitations: list,
}).strict().superRefine((value, issue) => {
  if (new Set(value.platformRoles.map((role) => role.platform)).size !== value.platformRoles.length) {
    issue.addIssue({ code: "custom", path: ["platformRoles"], message: "同一平台只能设置一个角色。" });
  }
});

export type SocialStrategyPayload = z.infer<typeof socialStrategyPayloadSchema>;

const draftSchema = z.object({
  payload: socialStrategyPayloadSchema,
  expectedDraftId: z.string().min(1).nullable().default(null),
  effectiveFrom: z.coerce.date().nullable().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
}).refine((value) => !value.effectiveFrom || !value.effectiveTo || value.effectiveFrom <= value.effectiveTo, {
  path: ["effectiveTo"], message: "结束日期不能早于开始日期。",
});

export const strategyProvenanceValues = ["CONFIRMED_BINDING", "DRAFT_PREVIEW", "UNBOUND_FALLBACK", "LEGACY_UNBOUND"] as const;
export type StrategyProvenance = (typeof strategyProvenanceValues)[number];
export type StrategyBinding = {
  strategy: SocialStrategy | null;
  provenance: Exclude<StrategyProvenance, "LEGACY_UNBOUND">;
};

type StrategyReader = Pick<Prisma.TransactionClient, "socialStrategy">;

function payloadOf(strategy: SocialStrategy): SocialStrategyPayload {
  return socialStrategyPayloadSchema.parse(strategy.payload);
}

function assertConfirmable(payload: SocialStrategyPayload) {
  if (!payload.businessGoal || !payload.primaryBuyer || !payload.targetMarkets.length) {
    throw new AppError("确认策略前必须填写业务目标、主要 Buyer 和目标市场。", 409, "STRATEGY_CONFIRMATION_INCOMPLETE");
  }
  if (!payload.platformRoles.length || !payload.contentPillars.length || !payload.postingCadence || !payload.coreMessage) {
    throw new AppError("确认策略前必须填写平台角色、内容支柱、发布节奏和核心信息。", 409, "STRATEGY_CONFIRMATION_INCOMPLETE");
  }
  for (const [name, values] of [["内容支柱", payload.contentPillars], ["内容形式", payload.formatMix]] as const) {
    if (values.length && values.reduce((sum, value) => sum + value.percentage, 0) !== 100) {
      throw new AppError(`${name}比例合计必须为 100%。`, 409, "STRATEGY_PERCENTAGE_INVALID");
    }
  }
}

async function lockClient(tx: Prisma.TransactionClient, clientId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Client" WHERE "id" = ${clientId} FOR UPDATE`;
  if (!locked.length) throw new AppError("客户不存在或无权访问。", 404, "CLIENT_NOT_FOUND");
}

export async function listSocialStrategies(context: RequestContext) {
  return db.socialStrategy.findMany({
    where: { clientId: context.clientId },
    orderBy: { version: "desc" },
  });
}

export async function createSocialStrategyDraft(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(parsed.error.issues.map((issue) => issue.message).join("；"), 400, "INVALID_STRATEGY_DRAFT");
  const input = parsed.data;
  return db.$transaction(async (tx) => {
    await lockClient(tx, context.clientId);
    const existing = await tx.socialStrategy.findFirst({ where: { clientId: context.clientId, status: SocialStrategyStatus.DRAFT } });
    if ((existing?.id ?? null) !== input.expectedDraftId) {
      throw new AppError("策略草稿已被其他人更新，请刷新页面后再编辑。", 409, "STRATEGY_VERSION_CONFLICT");
    }
    if (existing) await tx.socialStrategy.update({ where: { id: existing.id }, data: { status: SocialStrategyStatus.ARCHIVED } });
    const latest = await tx.socialStrategy.findFirst({ where: { clientId: context.clientId }, orderBy: { version: "desc" }, select: { version: true } });
    const strategy = await tx.socialStrategy.create({
      data: {
        clientId: context.clientId,
        version: (latest?.version || 0) + 1,
        status: SocialStrategyStatus.DRAFT,
        payload: input.payload as Prisma.InputJsonValue,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        createdByUserId: context.userId,
      },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId, userId: context.userId, action: "SOCIAL_STRATEGY_DRAFT_CREATED",
        entityType: "SocialStrategy", entityId: strategy.id,
        metadata: { version: strategy.version, previousDraftId: existing?.id ?? null, source: "HUMAN" },
      },
    });
    return strategy;
  });
}

export async function confirmSocialStrategy(context: RequestContext, strategyId: string) {
  assertCanWrite(context);
  return db.$transaction(async (tx) => {
    await lockClient(tx, context.clientId);
    const strategy = await tx.socialStrategy.findFirst({ where: { id: strategyId, clientId: context.clientId } });
    if (!strategy) throw new AppError("策略不存在或无权访问。", 404, "STRATEGY_NOT_FOUND");
    if (strategy.status !== SocialStrategyStatus.DRAFT) throw new AppError("只有当前草稿可以确认。", 409, "STRATEGY_NOT_DRAFT");
    const payload = payloadOf(strategy);
    assertConfirmable(payload);
    const [client, brand] = await Promise.all([
      tx.client.findUniqueOrThrow({ where: { id: context.clientId }, select: { targetMarkets: true } }),
      tx.brandProfile.findUnique({ where: { clientId: context.clientId }, select: { updatedAt: true } }),
    ]);
    await tx.socialStrategy.updateMany({ where: { clientId: context.clientId, status: SocialStrategyStatus.CONFIRMED }, data: { status: SocialStrategyStatus.ARCHIVED } });
    const confirmed = await tx.socialStrategy.update({
      where: { id: strategy.id },
      data: { status: SocialStrategyStatus.CONFIRMED, confirmedByUserId: context.userId, confirmedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId, userId: context.userId, action: "SOCIAL_STRATEGY_CONFIRMED",
        entityType: "SocialStrategy", entityId: strategy.id,
        metadata: {
          version: confirmed.version,
          brandProfileUpdatedAt: brand?.updatedAt.toISOString() ?? null,
          clientTargetMarketsSnapshot: client.targetMarkets,
        },
      },
    });
    return confirmed;
  });
}

export async function selectStrategyForGeneration(clientId: string, mode: ClientMode, reader: StrategyReader = db): Promise<StrategyBinding> {
  const confirmed = await reader.socialStrategy.findFirst({ where: { clientId, status: SocialStrategyStatus.CONFIRMED } });
  if (confirmed) return { strategy: confirmed, provenance: "CONFIRMED_BINDING" };
  if (mode === ClientMode.LIVE) throw new AppError("LIVE 客户需要先确认 SocialStrategy。", 409, "CONFIRMED_STRATEGY_REQUIRED");
  const draft = await reader.socialStrategy.findFirst({ where: { clientId, status: SocialStrategyStatus.DRAFT } });
  return draft ? { strategy: draft, provenance: "DRAFT_PREVIEW" } : { strategy: null, provenance: "UNBOUND_FALLBACK" };
}

export async function resolveStrategyForComposition(clientId: string, mode: ClientMode, strategyId: string | null): Promise<StrategyBinding> {
  if (!strategyId) {
    if (mode === ClientMode.LIVE) throw new AppError("历史内容未绑定策略；需要先由人工显式绑定。", 409, "STRATEGY_BINDING_REQUIRED");
    return { strategy: null, provenance: "UNBOUND_FALLBACK" };
  }
  const strategy = await db.socialStrategy.findFirst({ where: { id: strategyId, clientId } });
  if (!strategy) throw new AppError("内容绑定的策略不存在。", 409, "STRATEGY_BINDING_REQUIRED");
  if (mode === ClientMode.LIVE && !strategy.confirmedAt) {
    throw new AppError("LIVE 内容绑定的策略从未人工确认。", 409, "CONFIRMED_STRATEGY_REQUIRED");
  }
  return { strategy, provenance: strategy.confirmedAt ? "CONFIRMED_BINDING" : "DRAFT_PREVIEW" };
}

export function strategyProvenanceFacts(binding: StrategyBinding) {
  return {
    strategyProvenance: binding.provenance,
    socialStrategyId: binding.strategy?.id ?? null,
    socialStrategyVersion: binding.strategy?.version ?? null,
    socialStrategyStatus: binding.strategy?.status ?? null,
  };
}

export function readStrategyProvenance(sourceFacts: Prisma.JsonValue): StrategyProvenance {
  if (!sourceFacts || typeof sourceFacts !== "object" || Array.isArray(sourceFacts)) return "LEGACY_UNBOUND";
  const value = sourceFacts.strategyProvenance;
  return strategyProvenanceValues.includes(value as StrategyProvenance) ? value as StrategyProvenance : "LEGACY_UNBOUND";
}

export function strategyModelContext(binding: StrategyBinding) {
  if (!binding.strategy) return null;
  return {
    id: binding.strategy.id,
    version: binding.strategy.version,
    status: binding.strategy.status,
    provenance: binding.provenance,
    ...payloadOf(binding.strategy),
  };
}
