import { z } from "zod";

export const confirmedFactSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  source: z.string().min(1),
});

export const platformDraftSchema = z.object({
  platform: z.enum(["facebook", "instagram", "tiktok", "linkedin"]),
  title: z.string().max(200).nullable(),
  text: z.string().min(1),
  usedFactKeys: z.array(z.string()),
  missingInformation: z.array(z.string()),
  isGenericMarketDraft: z.boolean(),
});

export const generatedDraftsSchema = z.object({
  drafts: z.array(platformDraftSchema).min(1),
});

export type GeneratedDrafts = z.infer<typeof generatedDraftsSchema>;

export const interactionImportSchema = z.object({
  accountId: z.string().min(1).optional(),
  platform: z.string().min(1),
  platformRecordId: z.string().min(1),
  interactionType: z.enum(["COMMENT", "MESSAGE", "MANUAL_NOTE"]),
  authorHandle: z.string().optional(),
  authorDisplay: z.string().optional(),
  body: z.string().min(1),
  sourceUrl: z.string().url().optional().or(z.literal("")),
  occurredAt: z.coerce.date(),
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  modelNumber: z.string().optional(),
  fields: z.array(
    z.object({
      key: z.string().min(1),
      value: z.string().optional(),
      status: z.enum(["CONFIRMED", "PROPOSED", "MISSING"]),
      source: z.string().optional(),
    }),
  ),
}).superRefine((product, ctx) => {
  product.fields.forEach((field, index) => {
    if (field.status === "CONFIRMED" && (!field.value?.trim() || !field.source?.trim())) {
      ctx.addIssue({ code: "custom", path: ["fields", index], message: "确认事实必须同时填写值和客户来源。" });
    }
  });
});

export const researchRecordSchema = z.object({
  kind: z.enum(["COMPETITOR", "COMMUNITY", "MARKET"]),
  objective: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  observedAt: z.coerce.date(),
  observations: z.array(z.object({ fact: z.string().min(1), evidence: z.string().min(1) })),
  inferences: z.array(z.object({ inference: z.string().min(1), basis: z.string().min(1) })),
  experiments: z.array(z.object({ hypothesis: z.string().min(1), test: z.string().min(1) })),
  limitations: z.array(z.string()),
});
