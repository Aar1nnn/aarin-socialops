import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { updateProductFacts } from "@/services/product-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    const fields = ["material", "dimensions", "supply_scope"].map((key) => {
      const value = String(body[key] || "").trim();
      return {
        key,
        value,
        status: value ? (body[`${key}_confirmed`] === "on" ? "CONFIRMED" : "PROPOSED") : "MISSING",
        source: String(body[`${key}_source`] || "").trim(),
      };
    });
    const result = await updateProductFacts(context, id, {
      name: String(body.name || ""),
      modelNumber: String(body.modelNumber || ""),
      fields,
    });
    return actionResponse(request, result, "/products");
  } catch (error) {
    return errorResponse(error);
  }
}
