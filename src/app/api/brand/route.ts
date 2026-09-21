import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { getBrandProfile, upsertBrandProfile } from "@/services/brand-service";

function list(value: unknown) {
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}
export async function GET() {
  try {
    return Response.json(await getBrandProfile(await requireContext()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const result = await upsertBrandProfile(context, {
      businessSummary: String(body.businessSummary || ""),
      positioning: String(body.positioning || ""),
      audience: String(body.audience || ""),
      tone: String(body.tone || ""),
      voiceTraits: list(body.voiceTraits),
      goals: list(body.goals),
      contentLanguages: list(body.contentLanguages),
      imageStyle: String(body.imageStyle || ""),
      bannedPhrases: list(body.bannedPhrases),
      requiredMentions: list(body.requiredMentions),
      ctaRules: list(body.ctaRules),
    });
    return actionResponse(request, result, "/brand");
  } catch (error) {
    return errorResponse(error);
  }
}
