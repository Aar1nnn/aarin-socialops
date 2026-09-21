import { z } from "zod";
import { db } from "../lib/db";
import { assertCanWrite, type RequestContext } from "../lib/context";

export const brandProfileInputSchema = z.object({
  businessSummary: z.string().trim().min(1).max(4000),
  positioning: z.string().trim().max(2000).nullable().optional(),
  audience: z.string().trim().max(2000).nullable().optional(),
  tone: z.string().trim().max(1000).nullable().optional(),
  voiceTraits: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  goals: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  contentLanguages: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  imageStyle: z.string().trim().max(1000).nullable().optional(),
  bannedPhrases: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  requiredMentions: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  ctaRules: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
});

export type BrandProfileInput = z.infer<typeof brandProfileInputSchema>;

export async function getBrandProfile(context: RequestContext) {
  return db.brandProfile.findUnique({ where: { clientId: context.clientId } });
}

export async function upsertBrandProfile(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = brandProfileInputSchema.parse(raw);
  return db.brandProfile.upsert({
    where: { clientId: context.clientId },
    update: input,
    create: { clientId: context.clientId, ...input },
  });
}

export type BrandContext = {
  source: "STRUCTURED" | "LEGACY" | "EMPTY";
  clientName: string;
  businessSummary: string;
  positioning: string | null;
  audience: string | null;
  tone: string | null;
  voiceTraits: string[];
  goals: string[];
  contentLanguages: string[];
  imageStyle: string | null;
  bannedPhrases: string[];
  requiredMentions: string[];
  ctaRules: string[];
};

export async function buildBrandContext(context: RequestContext): Promise<BrandContext> {
  const client = await db.client.findUniqueOrThrow({
    where: { id: context.clientId },
    include: { brandProfile: true },
  });
  if (client.brandProfile) {
    const profile = client.brandProfile;
    return {
      source: "STRUCTURED",
      clientName: client.name,
      businessSummary: profile.businessSummary,
      positioning: profile.positioning,
      audience: profile.audience,
      tone: profile.tone,
      voiceTraits: profile.voiceTraits,
      goals: profile.goals,
      contentLanguages: profile.contentLanguages,
      imageStyle: profile.imageStyle,
      bannedPhrases: profile.bannedPhrases,
      requiredMentions: profile.requiredMentions,
      ctaRules: profile.ctaRules,
    };
  }
  return {
    source: client.brandGuidelines?.trim() ? "LEGACY" : "EMPTY",
    clientName: client.name,
    businessSummary: client.brandGuidelines?.trim() || "",
    positioning: null,
    audience: null,
    tone: client.brandGuidelines?.trim() || null,
    voiceTraits: [],
    goals: [],
    contentLanguages: [],
    imageStyle: null,
    bannedPhrases: [],
    requiredMentions: [],
    ctaRules: [],
  };
}
