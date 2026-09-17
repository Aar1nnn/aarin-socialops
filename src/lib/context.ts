import type { MembershipRole } from "@prisma/client";
import { AppError } from "./errors";

export type RequestContext = {
  userId: string;
  clientId: string;
  role: MembershipRole;
};

export function canWrite(role: MembershipRole): boolean {
  return role === "OWNER" || role === "OPERATOR";
}

export function assertCanWrite(context: RequestContext): void {
  if (!canWrite(context.role)) throw new AppError("当前角色只有查看权限。", 403, "FORBIDDEN");
}
