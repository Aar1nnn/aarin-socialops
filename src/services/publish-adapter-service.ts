import type { PublishJob, SocialAccount } from "@prisma/client";
import { AdapterRegistry } from "../lib/adapters/registry";
import type { SocialPublishAdapter } from "../lib/adapters/types";
import { AppError } from "../lib/errors";
import { getFacebookAdapterForJob } from "./facebook-service";

export async function resolvePublishAdapter(
  job: Pick<PublishJob, "clientId" | "accountId" | "provider" | "platform" | "adapter"> & { account: SocialAccount },
) {
  if (!job.provider || !job.platform) {
    if (job.adapter === "facebook-graph" && job.account.platform === "facebook") {
      return getFacebookAdapterForJob(job.clientId, job.accountId, "legacy");
    }
    throw new AppError("发布任务缺少 provider/platform 绑定。", 409, "JOB_TARGET_INCOMPLETE");
  }
  const registry = new AdapterRegistry<SocialPublishAdapter>();
  if (job.provider === "META" && job.platform === "facebook") {
    const mode = job.adapter === "meta-facebook" ? "oauth" : job.adapter === "facebook-graph" ? "legacy" : null;
    if (!mode) {
      throw new AppError(`不支持的 Meta/Facebook 发布适配器：${job.adapter}`, 409, "ADAPTER_NOT_REGISTERED");
    }
    registry.register({ provider: "META", platform: "facebook", capability: "PUBLISH" }, () =>
      getFacebookAdapterForJob(job.clientId, job.accountId, mode),
    );
  }
  return registry.resolve({ provider: job.provider, platform: job.platform, capability: "PUBLISH" });
}
