import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { AppError } from "./errors";
import { sha256 } from "./security";
import type { RequestContext } from "./context";

export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "socialops_session";

export async function getRequestContext(): Promise<RequestContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const now = new Date();
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= now) return null;
  const membership = await db.clientMembership.findUnique({
    where: {
      userId_clientId: { userId: session.userId, clientId: session.activeClientId },
    },
  });
  if (!membership) return null;
  await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  return { userId: session.userId, clientId: session.activeClientId, role: membership.role };
}

export async function requireContext(): Promise<RequestContext> {
  const context = await getRequestContext();
  if (!context) throw new AppError("请先登录。", 401, "UNAUTHENTICATED");
  return context;
}

export async function requirePageContext(): Promise<RequestContext> {
  const context = await getRequestContext();
  if (!context) redirect("/login");
  return context;
}
