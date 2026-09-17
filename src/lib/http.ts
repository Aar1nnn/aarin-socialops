import { NextResponse } from "next/server";

export async function requestData(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return (await request.json()) as Record<string, unknown>;
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export function actionResponse(request: Request, data: unknown, fallback: string) {
  const acceptsHtml = (request.headers.get("accept") || "").includes("text/html");
  if (acceptsHtml) return NextResponse.redirect(new URL(fallback, request.url), 303);
  return NextResponse.json(data);
}
