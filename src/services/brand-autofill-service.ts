import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { AppError } from "../lib/errors";
import { brandProfileInputSchema, getBrandProfile, upsertBrandProfile } from "./brand-service";

const textList = z.array(z.string().trim().min(1).max(300)).max(50);
const suggestedBrandSchema = z.object({
  businessSummary: z.string().trim().max(4000).nullable().optional(),
  positioning: z.string().trim().max(4000).nullable().optional(),
  audience: z.string().trim().max(4000).nullable().optional(),
  tone: z.string().trim().max(4000).nullable().optional(),
  voiceTraits: textList.optional(),
  goals: textList.optional(),
  contentLanguages: textList.optional(),
  imageStyle: z.string().trim().max(4000).nullable().optional(),
  bannedPhrases: textList.optional(),
  requiredMentions: textList.optional(),
  ctaRules: textList.optional(),
}).strict();

const sourceMaterialSchema = z.object({
  websiteText: z.string().trim().max(50_000).optional(),
  companyDescription: z.string().trim().max(20_000).optional(),
  existingBrandGuidelines: z.string().trim().max(20_000).optional(),
  productInformation: z.string().trim().max(20_000).optional(),
  manualNotes: z.string().trim().max(20_000).optional(),
  structured: suggestedBrandSchema.optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined && value !== ""), {
  message: "At least one source material field is required.",
});

const confirmationSchema = z.object({
  suggestions: suggestedBrandSchema,
  acceptedFields: z.array(z.string()).min(1).max(11),
  overrides: suggestedBrandSchema.optional(),
});

export type BrandAutofillAnalyzer = (input: z.infer<typeof sourceMaterialSchema>) => Promise<unknown>;

const brandFields = Object.keys(suggestedBrandSchema.shape) as Array<keyof z.infer<typeof suggestedBrandSchema>>;
const completenessFields = ["businessSummary", "audience", "tone", "goals", "voiceTraits", "ctaRules"] as const;
const listFields = new Set<keyof z.infer<typeof suggestedBrandSchema>>([
  "voiceTraits", "goals", "contentLanguages", "bannedPhrases", "requiredMentions", "ctaRules",
]);

function hasValue(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : value != null;
}

export function calculateBrandCompleteness(profile: Partial<z.infer<typeof suggestedBrandSchema>>) {
  const completedFields = completenessFields.filter((field) => hasValue(profile[field]));
  const missingFields = completenessFields.filter((field) => !hasValue(profile[field]));
  return {
    completedFields,
    missingFields,
    percent: Math.round((completedFields.length / completenessFields.length) * 100),
  };
}

async function defaultAnalyzer(input: z.infer<typeof sourceMaterialSchema>) {
  const summary = input.structured?.businessSummary
    || input.companyDescription
    || input.websiteText
    || input.productInformation
    || input.manualNotes;
  return {
    ...input.structured,
    businessSummary: summary?.slice(0, 4000) || undefined,
    tone: input.structured?.tone || input.existingBrandGuidelines?.slice(0, 4000) || undefined,
  };
}

export async function createBrandAutofillDraft(
  context: RequestContext,
  raw: unknown,
  analyzer: BrandAutofillAnalyzer = defaultAnalyzer,
) {
  assertCanWrite(context);
  const sourceMaterial = sourceMaterialSchema.parse(raw);
  const analysis = suggestedBrandSchema.parse(await analyzer(sourceMaterial));
  const suggestions = Object.fromEntries(
    brandFields
      .filter((field) => hasValue(analysis[field]))
      .map((field) => [field, { status: "SUGGESTED" as const, value: analysis[field] }]),
  );
  return {
    status: "SUGGESTED" as const,
    suggestions,
    completeness: calculateBrandCompleteness(analysis),
    persistence: "TRANSIENT" as const,
  };
}

export async function confirmBrandAutofill(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = confirmationSchema.parse(raw);
  const unknownFields = input.acceptedFields.filter((field) => !brandFields.includes(field as keyof typeof input.suggestions));
  if (unknownFields.length) throw new AppError(`Unsupported brand fields: ${unknownFields.join(", ")}`, 400, "INVALID_BRAND_FIELDS");

  const current = await getBrandProfile(context);
  const merged: Record<string, unknown> = {};
  for (const field of brandFields) {
    const existing = current[field];
    merged[field] = existing ?? (listFields.has(field) ? [] : null);
  }
  for (const fieldName of input.acceptedFields) {
    const field = fieldName as keyof z.infer<typeof suggestedBrandSchema>;
    const value = input.overrides?.[field] ?? input.suggestions[field];
    if (value !== undefined) merged[field] = value;
  }
  const profile = await upsertBrandProfile(context, brandProfileInputSchema.parse(merged));
  return {
    status: "CONFIRMED" as const,
    profile,
    acceptedFields: input.acceptedFields,
    completeness: calculateBrandCompleteness(profile),
  };
}

export const brandAutofillSchemas = {
  sourceMaterial: sourceMaterialSchema,
  suggestions: suggestedBrandSchema,
  confirmation: confirmationSchema,
};
