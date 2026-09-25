import type { BrandProfile } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { assertCanWrite, type RequestContext } from "../lib/context";

const optionalText = z.string().trim().max(4000).optional().nullable().transform((value) => value || null);
const textList = z.array(z.string().trim().min(1).max(300)).max(50).default([]);

export const brandProfileInputSchema = z.object({
  businessSummary: optionalText,
  positioning: optionalText,
  audience: optionalText,
  tone: optionalText,
  voiceTraits: textList,
  goals: textList,
  contentLanguages: textList,
  imageStyle: optionalText,
  bannedPhrases: textList,
  requiredMentions: textList,
  ctaRules: textList,
});

export type BrandProfileInput = z.input<typeof brandProfileInputSchema>;

export async function writeBrandProfileWithLock(
  context: RequestContext,
  resolveInput: (current: BrandProfile | null) => BrandProfileInput | Promise<BrandProfileInput>,
) {
  assertCanWrite(context);
  return db.$transaction(async (tx) => {
    const lockedClients = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Client"
      WHERE "id" = ${context.clientId}
      FOR UPDATE
    `;
    if (!lockedClients.length) throw new AppError("客户不存在或无权访问。", 404, "CLIENT_NOT_FOUND");

    const current = await tx.brandProfile.findUnique({ where: { clientId: context.clientId } });
    const input = brandProfileInputSchema.parse(await resolveInput(current));
    const profile = await tx.brandProfile.upsert({
      where: { clientId: context.clientId },
      update: input,
      create: { clientId: context.clientId, ...input },
    });
    await tx.auditLog.create({
      data: {
        clientId: context.clientId,
        userId: context.userId,
        action: "BRAND_PROFILE_UPDATED",
        entityType: "BrandProfile",
        entityId: profile.id,
        metadata: {
          voiceTraitCount: input.voiceTraits.length,
          goalCount: input.goals.length,
          languageCount: input.contentLanguages.length,
        },
      },
    });
    return profile;
  });
}

export async function getBrandProfile(context: RequestContext) {
  const client = await db.client.findUniqueOrThrow({
    where: { id: context.clientId },
    include: { brandProfile: true },
  });
  return {
    ...client.brandProfile,
    clientId: client.id,
    legacyBrandGuidelines: client.brandGuidelines,
    effectiveTone: client.brandProfile?.tone || client.brandGuidelines || null,
    source: client.brandProfile ? "STRUCTURED" as const : "LEGACY_FALLBACK" as const,
  };
}

export async function upsertBrandProfile(context: RequestContext, raw: BrandProfileInput) {
  const providedFields = new Set(Object.keys(raw));
  const requested = brandProfileInputSchema.parse(raw);
  return writeBrandProfileWithLock(context, (current) => {
    const merged: Record<string, unknown> = {};
    for (const field of Object.keys(brandProfileInputSchema.shape) as Array<keyof typeof requested>) {
      if (providedFields.has(field)) {
        merged[field] = requested[field];
      } else if (current) {
        merged[field] = current[field];
      }
    }
    return merged;
  });
}
