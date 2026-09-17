import { db } from "../lib/db";
import { sha256 } from "../lib/security";

export type LoginRateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function config() {
  return {
    maxFailures: Number(process.env.LOGIN_MAX_FAILURES || 5),
    windowMs: Number(process.env.LOGIN_WINDOW_SECONDS || 900) * 1000,
    blockMs: Number(process.env.LOGIN_BLOCK_SECONDS || 900) * 1000,
  };
}

export function loginRateLimitKeys(email: string, request: Request): string[] {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  const keys = [sha256(`login:email:${email.trim().toLowerCase()}`)];
  if (forwarded) keys.push(sha256(`login:ip:${forwarded}`));
  return keys;
}

export async function checkLoginAllowed(keys: string[], now = new Date()): Promise<LoginRateLimitResult> {
  const blocked = await db.loginRateLimit.findFirst({ where: { keyHash: { in: keys }, blockedUntil: { gt: now } }, orderBy: { blockedUntil: "desc" } });
  if (!blocked?.blockedUntil) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((blocked.blockedUntil.getTime() - now.getTime()) / 1000)) };
}

export async function recordLoginFailure(keys: string[], now = new Date()): Promise<LoginRateLimitResult> {
  const { maxFailures, windowMs, blockMs } = config();
  let latestBlockMs = 0;
  for (const keyHash of keys) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${keyHash})::bigint)::text AS "locked"`;
      const current = await tx.loginRateLimit.findUnique({ where: { keyHash } });
      const reset = !current || current.windowStarted.getTime() <= now.getTime() - windowMs;
      const failureCount = reset ? 1 : current.failureCount + 1;
      const blockedUntil = failureCount >= maxFailures ? new Date(now.getTime() + blockMs) : current?.blockedUntil && current.blockedUntil > now ? current.blockedUntil : null;
      await tx.loginRateLimit.upsert({
        where: { keyHash },
        create: { keyHash, failureCount, windowStarted: now, lastFailureAt: now, blockedUntil },
        update: { failureCount, windowStarted: reset ? now : current!.windowStarted, lastFailureAt: now, blockedUntil },
      });
      if (blockedUntil) latestBlockMs = Math.max(latestBlockMs, blockedUntil.getTime());
    });
  }
  if (!latestBlockMs) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((latestBlockMs - now.getTime()) / 1000)) };
}

export async function clearLoginFailures(keys: string[]) {
  await db.loginRateLimit.deleteMany({ where: { keyHash: { in: keys } } });
}
