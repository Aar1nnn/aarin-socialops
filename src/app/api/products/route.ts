import { requireContext } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { createProduct } from "@/services/product-service";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const fields = ["material", "dimensions", "supply_scope"].map((key) => {
      const value = String(body[key] || "").trim();
      const confirmed = body[`${key}_confirmed`] === "on";
      return {
        key,
        value,
        status: value ? (confirmed ? "CONFIRMED" : "PROPOSED") : "MISSING",
        source: String(body[`${key}_source`] || "").trim(),
      };
    });
    const product = await createProduct(context, {
      name: String(body.name || ""),
      modelNumber: String(body.modelNumber || ""),
      fields,
    });
    return actionResponse(request, product, "/products");
  } catch (error) {
    return errorResponse(error);
  }
}
