import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { upsertBrandProfile } from "@/services/brand-service";

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const profile = await upsertBrandProfile(context, {
      businessSummary: body.businessSummary,
      positioning: body.positioning || null,
      audience: body.audience || null,
      tone: body.tone || null,
      voiceTraits: list(body.voiceTraits),
      goals: list(body.goals),
      contentLanguages: list(body.contentLanguages),
      imageStyle: body.imageStyle || null,
      bannedPhrases: list(body.bannedPhrases),
      requiredMentions: list(body.requiredMentions),
      ctaRules: list(body.ctaRules),
    });
    return actionResponse(request, profile, "/brand");
  } catch (error) {
    return errorResponse(error);
  }
}
