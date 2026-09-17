import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";
import { createSessionToken, verifyPassword } from "@/lib/security";
import { errorResponse } from "@/lib/errors";
import { requestData } from "@/lib/http";
import { checkLoginAllowed, clearLoginFailures, loginRateLimitKeys, recordLoginFailure } from "@/services/login-rate-limit-service";

export async function POST(request: Request) {
  try {
    const body = await requestData(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const rateLimitKeys = loginRateLimitKeys(email, request);
    const allowed = await checkLoginAllowed(rateLimitKeys);
    if (!allowed.allowed) {
      return NextResponse.json({ error: "LOGIN_RATE_LIMITED", message: "登录失败次数过多，请稍后再试。" }, { status: 429, headers: { "retry-after": String(allowed.retryAfterSeconds) } });
    }
    const user = await db.user.findUnique({
      where: { email },
      include: { memberships: { include: { client: true } } },
    });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      const afterFailure = await recordLoginFailure(rateLimitKeys);
      if (!afterFailure.allowed) {
        return NextResponse.json({ error: "LOGIN_RATE_LIMITED", message: "登录失败次数过多，请稍后再试。" }, { status: 429, headers: { "retry-after": String(afterFailure.retryAfterSeconds) } });
      }
      return NextResponse.json({ error: "INVALID_LOGIN", message: "邮箱或密码错误。" }, { status: 401 });
    }
    const membership = user.memberships.find((item) => item.client.isDemo) || user.memberships[0];
    if (!membership) return NextResponse.json({ error: "NO_CLIENT", message: "此用户没有客户权限。" }, { status: 403 });
    await clearLoginFailures(rateLimitKeys);
    const { token, tokenHash } = createSessionToken();
    const ttlHours = Number(process.env.SESSION_TTL_HOURS || 168);
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const secureCookie = process.env.COOKIE_SECURE === undefined
      ? forwardedProtocol === "https" || new URL(request.url).protocol === "https:"
      : process.env.COOKIE_SECURE === "true";
    await db.session.create({
      data: {
        tokenHash,
        userId: user.id,
        activeClientId: membership.clientId,
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      },
    });
    const response = NextResponse.redirect(new URL("/", request.url), 303);
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      path: "/",
      maxAge: ttlHours * 60 * 60,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
