import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, requireContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/security";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const context = await requireContext();
    const body = await requestData(request);
    const clientId = String(body.clientId || "");
    const membership = await db.clientMembership.findUnique({
      where: { userId_clientId: { userId: context.userId, clientId } },
    });
    if (!membership) return NextResponse.json({ error: "FORBIDDEN", message: "无权切换到该客户。" }, { status: 403 });
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return NextResponse.redirect(new URL("/login", request.url), 303);
    await db.session.update({ where: { tokenHash: sha256(token) }, data: { activeClientId: clientId } });
    return NextResponse.redirect(new URL("/", request.url), 303);
  } catch (error) {
    return errorResponse(error);
  }
}
