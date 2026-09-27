import { requireContext } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { requestData, actionResponse } from "@/lib/http";
import { updateProductFacts } from "@/services/product-service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext();
    const { id } = await params;
    const body = await requestData(request);
    const fields = Array.isArray(body.fields) ? body.fields : (() => {
      let keys: unknown;
      try { keys = JSON.parse(String(body.fieldKeys || '["material","dimensions","supply_scope"]')); }
      catch { throw new AppError("产品字段列表无效。", 400, "INVALID_PRODUCT_FIELDS"); }
      if (!Array.isArray(keys) || keys.length > 100 || !keys.every((key) => typeof key === "string" && key.length > 0 && key.length <= 100)) {
        throw new AppError("产品字段列表无效。", 400, "INVALID_PRODUCT_FIELDS");
      }
      const mapped = keys.map((key) => ({
        key,
        value: String(body[`fact_value_${key}`] ?? body[key] ?? "").trim(),
        status: body[`fact_status_${key}`] ?? (body[key] ? body[`${key}_confirmed`] === "on" ? "CONFIRMED" : "PROPOSED" : "MISSING"),
        source: String(body[`fact_source_${key}`] ?? body[`${key}_source`] ?? "").trim(),
      }));
      const newKey = String(body.newFactKey || "").trim();
      if (newKey) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(newKey)) throw new AppError("自定义事实字段键无效。", 400, "INVALID_PRODUCT_FIELD_KEY");
        mapped.push({ key: newKey, value: String(body.newFactValue || "").trim(), status: body.newFactStatus || "PROPOSED", source: String(body.newFactSource || "").trim() });
      } else if (body.newFactValue || body.newFactSource) {
        throw new AppError("新增事实必须填写字段键。", 400, "PRODUCT_FIELD_KEY_REQUIRED");
      }
      return mapped;
    })();
    const result = await updateProductFacts(context, id, {
      name: String(body.name || ""),
      modelNumber: String(body.modelNumber || ""),
      fields,
      expectedDataVersion: body.expectedDataVersion,
    });
    return actionResponse(request, result, `/products/${id}`);
  } catch (error) {
    if (error instanceof AppError && error.code === "PRODUCT_VERSION_CONFLICT" && (request.headers.get("accept") || "").includes("text/html")) {
      const { id } = await params;
      const returnPath = `/products/${encodeURIComponent(id).replace(/'/g, "%27")}`;
      return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>产品资料已更新</title></head><body><main><h1>产品资料已由其他人更新</h1><p>本次修改没有保存。请刷新产品详情，核对最新事实后重试。</p><p><a href="${returnPath}">返回并刷新产品详情</a></p></main></body></html>`, {
        status: 409,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return errorResponse(error);
  }
}
