import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { createManualContent } from "@/services/manual-content-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const contentType = request.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await request.json()
      : await (async () => {
          const form = await request.formData();
          return { ...Object.fromEntries(form.entries()), assetIds: form.getAll("assetIds").map(String).filter(Boolean) };
        })();
    const result = await createManualContent(context, body);
    if ((request.headers.get("accept") || "").includes("text/html")) {
      return Response.redirect(new URL(`/content/${result.item.id}`, request.url), 303);
    }
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
