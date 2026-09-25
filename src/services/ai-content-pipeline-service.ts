import { z } from "zod";
import type { DraftGenerationInput, DraftGenerationResult, TextGenerationAdapter } from "../lib/adapters/types";
import type { RequestContext } from "../lib/context";
import { generatedDraftsSchema } from "../lib/contracts";
import { AppError } from "../lib/errors";
import { buildCompositionContext } from "./context-builder-service";

export const contentStrategySchema = z.object({
  audience: z.string().min(1),
  messageAngle: z.string().min(1),
  contentGoal: z.string().min(1),
  differentiation: z.array(z.string()),
});

export const aiReviewSchema = z.object({
  platform: z.string(),
  passed: z.boolean(),
  findings: z.array(z.object({
    code: z.string(),
    severity: z.enum(["INFO", "WARNING", "ERROR"]),
    message: z.string(),
  })),
});

export type PipelineBaseInput = Omit<DraftGenerationInput,
  "brandProfile" | "recentContent" | "performanceContext" | "researchContext" | "strategy">;

export function generateStrategy(input: PipelineBaseInput, brand: Awaited<ReturnType<typeof buildCompositionContext>>["brand"]) {
  return contentStrategySchema.parse({
    audience: brand.audience || "Qualified business buyers defined by the operator",
    messageAngle: input.theme,
    contentGoal: input.objective,
    differentiation: input.confirmedFacts.slice(0, 5).map((fact) => `${fact.key}: ${fact.value}`),
  });
}

function normalizeHumanizedText(text: string) {
  return text.replace(/[ \t]+/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
}

function shorten(text: string, limit: number | null | undefined) {
  if (!limit || text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  const clipped = text.slice(0, limit - 1);
  const lastBoundary = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("。"), clipped.lastIndexOf("\n"));
  return `${(lastBoundary > limit * 0.55 ? clipped.slice(0, lastBoundary + 1) : clipped).trim()}…`;
}

export function reviewDraft(input: DraftGenerationInput, draft: DraftGenerationResult["output"]["drafts"][number]) {
  const findings: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string }> = [];
  for (const phrase of input.brandProfile?.bannedPhrases || []) {
    if (draft.text.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())) {
      findings.push({ code: "BANNED_PHRASE", severity: "ERROR", message: `Content contains a banned phrase: ${phrase}` });
    }
  }
  for (const mention of input.brandProfile?.requiredMentions || []) {
    if (!draft.text.toLocaleLowerCase().includes(mention.toLocaleLowerCase())) {
      findings.push({ code: "REQUIRED_MENTION_MISSING", severity: "WARNING", message: `Required mention is absent: ${mention}` });
    }
  }
  const recentDuplicate = (input.recentContent || []).some((item) => item.platform === draft.platform && item.hook === draft.text.split(/(?<=[.!?。！？])\s+/u)[0]);
  if (recentDuplicate) findings.push({ code: "RECENT_HOOK_DUPLICATE", severity: "WARNING", message: "Opening hook duplicates recent content." });
  if (draft.usedFactKeys.some((key) => !input.confirmedFacts.some((fact) => fact.key === key))) {
    findings.push({ code: "UNCONFIRMED_FACT_REFERENCE", severity: "ERROR", message: "Draft references a fact key outside confirmed facts." });
  }
  return aiReviewSchema.parse({ platform: draft.platform, passed: !findings.some((item) => item.severity === "ERROR"), findings });
}

export function buildImagePromptInterface(input: DraftGenerationInput, draft: DraftGenerationResult["output"]["drafts"][number]) {
  return {
    status: "INTERFACE_ONLY" as const,
    prompt: [input.brandProfile?.imageStyle, input.productName, input.strategy?.messageAngle, draft.platform].filter(Boolean).join("; "),
    reviewRequired: true,
  };
}

export async function runAIContentPipeline(
  context: RequestContext,
  baseInput: PipelineBaseInput,
  adapter: TextGenerationAdapter,
  platformLimits: Partial<Record<string, number | null>> = {},
): Promise<DraftGenerationResult & { pipeline: Record<string, unknown> }> {
  return runPreparedAIContentPipeline(await prepareAIContentPipelineInput(context, baseInput), adapter, platformLimits);
}

export async function prepareAIContentPipelineInput(context: RequestContext, baseInput: PipelineBaseInput): Promise<DraftGenerationInput> {
  const compositionContext = await buildCompositionContext(context);
  const strategy = generateStrategy(baseInput, compositionContext.brand);
  return {
    ...baseInput,
    brandProfile: {
      businessSummary: compositionContext.brand.businessSummary || null,
      positioning: compositionContext.brand.positioning || null,
      audience: compositionContext.brand.audience || null,
      tone: compositionContext.brand.tone || compositionContext.brand.effectiveTone,
      voiceTraits: compositionContext.brand.voiceTraits || [],
      goals: compositionContext.brand.goals || [],
      contentLanguages: compositionContext.brand.contentLanguages || [],
      imageStyle: compositionContext.brand.imageStyle || null,
      bannedPhrases: compositionContext.brand.bannedPhrases || [],
      requiredMentions: compositionContext.brand.requiredMentions || [],
      ctaRules: compositionContext.brand.ctaRules || [],
    },
    recentContent: compositionContext.recentContent.map(({ platform, theme, hook, cta, product }) => ({ platform, theme, hook, cta, product })),
    performanceContext: compositionContext.performance.map(({ metricKey, platform, value, availability, dataKind }) => ({ metricKey, platform, value, availability, dataKind })),
    researchContext: compositionContext.research.map(({ kind, objective, observations, limitations }) => ({ kind, objective, observations, limitations })),
    strategy,
  };
}

export async function runPreparedAIContentPipeline(
  input: DraftGenerationInput,
  adapter: TextGenerationAdapter,
  platformLimits: Partial<Record<string, number | null>> = {},
): Promise<DraftGenerationResult & { pipeline: Record<string, unknown> }> {
  const strategy = contentStrategySchema.parse(input.strategy);
  const generated = await adapter.generate(input);
  generated.output = generatedDraftsSchema.parse(generated.output);
  const confirmedFactKeys = new Set(input.confirmedFacts.map((fact) => fact.key));
  const unconfirmedUsedKeys = [...new Set(generated.output.drafts.flatMap((draft) => draft.usedFactKeys)
    .filter((key) => !confirmedFactKeys.has(key)))];
  if (unconfirmedUsedKeys.length) {
    throw new AppError(`AI used unconfirmed fact keys: ${unconfirmedUsedKeys.join(", ")}`, 422, "AI_UNCONFIRMED_FACT_USED");
  }
  const reviews = generated.output.drafts.map((draft) => reviewDraft(input, draft));
  const drafts = generated.output.drafts.map((draft) => ({
    ...draft,
    text: shorten(normalizeHumanizedText(draft.text), platformLimits[draft.platform]),
  }));
  const imagePrompts = drafts.map((draft) => ({ platform: draft.platform, ...buildImagePromptInterface(input, draft) }));
  return {
    ...generated,
    output: { drafts },
    pipeline: {
      stages: ["brand_context", "memory", "strategy", "generation", "platform_variants", "ai_review", "humanizer", "shortener", "image_prompt_interface"],
      strategy,
      reviews,
      imagePrompts,
      humanApprovalRequired: true,
      approvalCreated: false,
      publishJobCreated: false,
    },
  };
}
