import { ContentStatus, PublishJobStatus } from "@prisma/client";
import type { SocialPublishAdapter } from "../lib/adapters/types";
import { assertCanWrite, type RequestContext } from "../lib/context";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";
import { resolvePublishAdapter } from "./publish-adapter-service";

export async function queryPlatformPublish(
  context: RequestContext,
  publishJobId: string,
  adapterOverride?: SocialPublishAdapter,
) {
  assertCanWrite(context);
  const job = await db.publishJob.findFirst({
    where: { id: publishJobId, clientId: context.clientId },
    include: {
      account: { include: { facebookConnection: true, platformConnection: true } },
      contentVersion: { select: { contentItemId: true } },
    },
  });
  if (!job || job.account.clientId !== context.clientId) {
    throw new AppError("发布任务不存在或无权访问。", 404, "PUBLISH_JOB_NOT_FOUND");
  }
  if (job.adapter === "manual") throw new AppError("人工发布没有平台 API 查询能力，请人工核实并记录证据。", 409, "MANUAL_QUERY_UNSUPPORTED");
  if (job.environment !== "LIVE" || job.simulated) {
    throw new AppError("只有真实平台发布任务支持远端查询。", 409, "NOT_LIVE_PUBLISH_JOB");
  }
  if (!job.remotePostId) {
    throw new AppError("任务没有远端帖子 ID，无法自动查询；请在平台后台人工对账。", 409, "REMOTE_POST_ID_MISSING");
  }

  const adapter = adapterOverride || await resolvePublishAdapter(job);
  if (!adapter.queryByRemotePostId) {
    throw new AppError("当前平台适配器不支持远端状态查询。", 409, "REMOTE_QUERY_UNSUPPORTED");
  }
  const result = await adapter.queryByRemotePostId(job.remotePostId);
  const queriedAt = new Date();
  if (result.status === "published") {
    return db.$transaction(async (tx) => {
      const updated = await tx.publishJob.update({
        where: { id: job.id },
        data: {
          status: PublishJobStatus.PUBLISHED,
          remotePostId: result.remotePostId,
          remotePostUrl: result.remotePostUrl,
          publishedAt: result.publishedAt,
          lastQueriedAt: queriedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      const item = await tx.contentItem.findUnique({ where: { id: job.contentVersion.contentItemId } });
      if (item?.currentVersionId === job.contentVersionId) {
        await tx.contentItem.update({ where: { id: item.id }, data: { status: ContentStatus.PUBLISHED } });
      }
      await tx.auditLog.create({
        data: {
          clientId: context.clientId,
          userId: context.userId,
          action: "PLATFORM_PUBLISH_QUERIED",
          entityType: "PublishJob",
          entityId: job.id,
          metadata: {
            provider: job.provider,
            platform: job.platform,
            outcome: "PUBLISHED",
            remotePostId: result.remotePostId,
          },
        },
      });
      return updated;
    });
  }

  if (result.code === "TOKEN_INVALID" || result.code === "PERMISSION_DENIED") {
    await invalidatePublishConnection(job.account, result.code, result.message);
  }
  return db.publishJob.update({
    where: { id: job.id },
    data: {
      lastQueriedAt: queriedAt,
      lastErrorCode: result.code,
      lastErrorMessage: result.message,
    },
  });
}

async function invalidatePublishConnection(
  account: {
    id: string;
    clientId: string;
    platformConnectionId: string | null;
    facebookConnection: { id: string } | null;
  },
  code: "TOKEN_INVALID" | "PERMISSION_DENIED",
  message: string,
) {
  await db.$transaction(async (tx) => {
    if (account.facebookConnection) {
      await tx.facebookPageConnection.update({
        where: { id: account.facebookConnection.id },
        data: {
          connectionStatus: "UNVERIFIED",
          tokenStatus: code === "TOKEN_INVALID" ? "EXPIRED" : "VALID",
          lastCheckedAt: new Date(),
          lastErrorCategory: code,
          lastErrorMessage: message,
        },
      });
    }
    if (account.platformConnectionId) {
      await tx.platformConnection.updateMany({
        where: { id: account.platformConnectionId, clientId: account.clientId },
        data: {
          status: code === "TOKEN_INVALID" ? "TOKEN_EXPIRED" : "PERMISSION_MISSING",
          lastErrorCode: code,
          lastErrorMessage: message,
        },
      });
    }
    await tx.socialAccount.update({
      where: { id: account.id },
      data: {
        publishCapability: "UNVERIFIED",
        metricsCapability: "UNVERIFIED",
        commentsCapability: "UNVERIFIED",
        verifiedAt: null,
      },
    });
  });
}
