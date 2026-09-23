import type { PublishJob, SocialAccount } from "@prisma/client";
import { AppError } from "../lib/errors";
import { getPlatformRegistry } from "./platform-registry-service";

export async function resolvePublishAdapter(
  job: Pick<PublishJob, "clientId" | "accountId" | "provider" | "platform" | "adapter"> & { account: SocialAccount },
) {
  if (!job.provider || !job.platform) {
    throw new AppError("发布任务缺少 provider/platform 绑定。", 409, "JOB_TARGET_INCOMPLETE");
  }
  try {
    return await getPlatformRegistry().resolvePublishAdapter(job.provider, job.platform, {
      clientId: job.clientId,
      accountId: job.accountId,
      adapterName: job.adapter,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = error instanceof Error && error.message.startsWith("ADAPTER_NOT_REGISTERED:")
      ? "ADAPTER_NOT_REGISTERED"
      : "PLATFORM_NOT_REGISTERED";
    throw new AppError(error instanceof Error ? error.message : "发布平台未注册。", 409, code);
  }
}
