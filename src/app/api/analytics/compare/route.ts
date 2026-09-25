import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { canonicalMetricKeys, compareAccounts, comparePosts, periodBounds, queryAnalyticsMetrics } from "@/services/analytics-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    if (body.type === "posts" && Array.isArray(body.ids)) return Response.json(await comparePosts(context, body.ids));
    if (body.type === "accounts" && Array.isArray(body.ids) && canonicalMetricKeys.includes(body.metric as never)) {
      return Response.json(await compareAccounts(context, body.ids.map(String), body.metric as never, body.from ? new Date(String(body.from)) : undefined, body.to ? new Date(String(body.to)) : undefined));
    }
    if (body.type === "period") {
      const bounds = periodBounds(body.now ? new Date(String(body.now)) : new Date(), body.grain === "day" || body.grain === "month" ? body.grain : "week");
      const metrics = await queryAnalyticsMetrics(context, { from: bounds.previousStart, to: bounds.currentEnd, latestOnly: false, metric: body.metric });
      return Response.json({ bounds, metrics });
    }
    return Response.json({ error: "INVALID_ANALYTICS_COMPARISON", message: "Unsupported analytics comparison." }, { status: 400 });
  } catch (error) { return errorResponse(error); }
}
