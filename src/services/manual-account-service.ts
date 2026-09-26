import { CapabilityStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { MANUAL_PLATFORMS, manualAccountMetadata, manualAccountProfileUrl } from "../lib/manual-account";

const accountTypes = {
  linkedin: ["LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION"],
  tiktok: ["TIKTOK_ACCOUNT"],
  youtube: ["YOUTUBE_CHANNEL"],
} as const;

const manualAccountSchema = z.object({
  platform: z.enum(MANUAL_PLATFORMS),
  accountType: z.string().min(1),
  displayName: z.string().trim().min(1).max(200),
  profileUrl: z.url().max(2000),
}).superRefine((value, context) => {
  if (!accountTypes[value.platform].some((type) => type === value.accountType)) {
    context.addIssue({ code: "custom", path: ["accountType"], message: "账号类型与平台不匹配。" });
  }
  if (new URL(value.profileUrl).protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["profileUrl"], message: "主页必须使用 HTTPS。" });
  }
});

export async function createManualAccount(context: RequestContext, raw: unknown) {
  assertCanWrite(context);
  const input = manualAccountSchema.parse(raw);
  const profileUrl = new URL(input.profileUrl).toString();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${context.clientId} FOR UPDATE`;
    const accounts = await tx.socialAccount.findMany({
      where: { clientId: context.clientId, platform: input.platform },
      select: { platform: true, metadata: true },
    });
    if (accounts.some((account) => manualAccountProfileUrl(account) === profileUrl)) {
      throw new AppError("该人工账号主页已存在。", 409, "MANUAL_ACCOUNT_EXISTS");
    }
    const account = await tx.socialAccount.create({
      data: {
        clientId: context.clientId,
        platform: input.platform,
        accountType: input.accountType,
        displayName: input.displayName,
        metadata: manualAccountMetadata(profileUrl) as Prisma.InputJsonValue,
        isSelected: true,
        publishCapability: CapabilityStatus.UNSUPPORTED,
        metricsCapability: CapabilityStatus.UNSUPPORTED,
        commentsCapability: CapabilityStatus.UNSUPPORTED,
        messagesCapability: CapabilityStatus.UNSUPPORTED,
        groupsCapability: CapabilityStatus.UNSUPPORTED,
      },
    });
    await tx.auditLog.create({
      data: { clientId: context.clientId, userId: context.userId, action: "MANUAL_ACCOUNT_CREATED", entityType: "SocialAccount", entityId: account.id, metadata: { platform: input.platform, profileUrl } },
    });
    return account;
  });
}
