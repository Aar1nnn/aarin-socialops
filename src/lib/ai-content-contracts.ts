import { z } from "zod";

export const aiStrategySchema = z.object({
  objective: z.string().min(1),
  angle: z.string().min(1),
  audience: z.string().min(1),
  keyMessages: z.array(z.string().min(1)).min(1).max(8),
  cta: z.string().min(1),
});

export const aiDraftSchema = z.object({
  title: z.string().max(200).nullable(),
  text: z.string().min(1),
  usedFactKeys: z.array(z.string()),
  missingInformation: z.array(z.string()),
});

export const aiReviewSchema = z.object({
  verdict: z.enum(["PASS", "NEEDS_REVISION"]),
  score: z.number().int().min(0).max(100),
  issues: z.array(z.object({
    code: z.string().min(1),
    severity: z.enum(["INFO", "WARNING", "ERROR"]),
    message: z.string().min(1),
  })).max(20),
});

export const aiRewriteSchema = z.object({ text: z.string().min(1) });

export type AiStrategy = z.infer<typeof aiStrategySchema>;
export type AiDraft = z.infer<typeof aiDraftSchema>;
export type AiReview = z.infer<typeof aiReviewSchema>;
export type AiRewrite = z.infer<typeof aiRewriteSchema>;

export type AiPipelineContext = {
  clientId: string;
  contentItemId: string;
  currentVersionId: string | null;
  platform: string;
  objective: string;
  theme: string;
  brand: unknown;
  product: { id: string; name: string; dataVersion: number } | null;
  confirmedFacts: Array<{ key: string; value: string; source: string }>;
  missingFactKeys: string[];
  contentMemory: unknown;
  performanceMemory: unknown;
  researchMemory: unknown;
  maxTextLength: number | null;
};

export interface AiContentStageAdapter {
  readonly name: string;
  readonly simulated: boolean;
  strategy(context: AiPipelineContext, intent: string): Promise<AiStrategy>;
  generate(context: AiPipelineContext, strategy: AiStrategy): Promise<AiDraft>;
  review(context: AiPipelineContext, strategy: AiStrategy, draft: AiDraft): Promise<AiReview>;
  humanize(context: AiPipelineContext, draft: AiDraft, review: AiReview): Promise<AiRewrite>;
  shorten(context: AiPipelineContext, rewrite: AiRewrite): Promise<AiRewrite>;
}
