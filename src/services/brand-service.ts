import { z } from "zod";
import { db } from "../lib/db";
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
  assertCanWrite(context);
  const input = brandProfileInputSchema.parse(raw);
  return db.$transaction(async (tx) => {
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
