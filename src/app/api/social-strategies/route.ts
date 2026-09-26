import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { actionResponse, requestData } from "@/lib/http";
import { createSocialStrategyDraft, listSocialStrategies } from "@/services/social-strategy-service";

function lines(value: unknown) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function weighted(value: unknown) {
  return lines(value).map((line) => {
    const [name, percentage] = line.split("|").map((part) => part.trim());
    return { name, percentage: Number(percentage) };
  });
}

function formPayload(body: Record<string, unknown>) {
  return {
    businessGoal: String(body.businessGoal || ""),
    primaryBuyer: String(body.primaryBuyer || ""),
    targetMarkets: lines(body.targetMarkets),
    platformRoles: lines(body.platformRoles).map((line) => {
      const [platform, role] = line.split("|").map((part) => part.trim());
      return { platform, role };
    }),
    contentPillars: weighted(body.contentPillars),
    formatMix: weighted(body.formatMix),
    postingCadence: String(body.postingCadence || ""),
    coreMessage: String(body.coreMessage || ""),
    ctaGuidance: lines(body.ctaGuidance),
    priorityProducts: lines(body.priorityProducts),
    assetPriorities: lines(body.assetPriorities),
    experiments: lines(body.experiments),
    limitations: lines(body.limitations),
  };
}

export async function GET() {
  try {
    return Response.json(await listSocialStrategies(await requireContext()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const input = {
      payload: request.headers.get("content-type")?.includes("application/json") ? body.payload : formPayload(body),
      effectiveFrom: body.effectiveFrom || null,
      effectiveTo: body.effectiveTo || null,
    };
    return actionResponse(request, await createSocialStrategyDraft(context, input), "/strategy");
  } catch (error) {
    return errorResponse(error);
  }
}
