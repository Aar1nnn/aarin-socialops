import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.nextUrl.host) {
      return NextResponse.json({ error: "CROSS_ORIGIN_WRITE_BLOCKED", message: "拒绝跨站写入请求。" }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
