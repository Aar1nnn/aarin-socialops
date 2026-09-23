import type { Provider } from "@prisma/client";
import {
  FACEBOOK_PLATFORM_DEFINITION,
  INSTAGRAM_PLATFORM_DEFINITION,
  LINKEDIN_PLATFORM_DEFINITION,
  TIKTOK_PLATFORM_DEFINITION,
  YOUTUBE_PLATFORM_DEFINITION,
} from "../lib/platforms/capabilities";
import {
  PlatformRegistry,
  type LivePublishAccount,
} from "../lib/platforms/registry";
import { AppError } from "../lib/errors";
import { getFacebookAdapterForJob } from "./facebook-service";
import { getInstagramAdapterForJob } from "./instagram-service";

let singleton: PlatformRegistry | null = null;

export function getPlatformRegistry() {
  if (singleton) return singleton;
  const registry = new PlatformRegistry();
  registry.register({
    definition: FACEBOOK_PLATFORM_DEFINITION,
    selectLiveAdapter(account) {
      if (!baseAccountReady(account)) return null;
      if (oauthConnectionReady(account, "META")) return "meta-facebook";
      const legacy = account.legacyFacebook;
      if (
        legacy?.connectionStatus === "VERIFIED" &&
        legacy.tokenStatus === "VALID" &&
        legacy.pageId === account.externalAccountId
      ) {
        return "facebook-graph";
      }
      return null;
    },
    async createPublishAdapter(input) {
      const mode = input.adapterName === "meta-facebook"
        ? "oauth"
        : input.adapterName === "facebook-graph"
          ? "legacy"
          : null;
      if (!mode) throw new AppError(`不支持的 Meta/Facebook 发布适配器：${input.adapterName}`, 409, "ADAPTER_NOT_REGISTERED");
      return getFacebookAdapterForJob(input.clientId, input.accountId, mode);
    },
  });
  registry.register({
    definition: INSTAGRAM_PLATFORM_DEFINITION,
    selectLiveAdapter(account) {
      return baseAccountReady(account) && oauthConnectionReady(account, "META")
        ? "meta-instagram"
        : null;
    },
    async createPublishAdapter(input) {
      if (input.adapterName !== "meta-instagram") {
        throw new AppError(`不支持的 Meta/Instagram 发布适配器：${input.adapterName}`, 409, "ADAPTER_NOT_REGISTERED");
      }
      return getInstagramAdapterForJob(input.clientId, input.accountId);
    },
  });
  registry.register({ definition: LINKEDIN_PLATFORM_DEFINITION });
  registry.register({ definition: TIKTOK_PLATFORM_DEFINITION });
  registry.register({ definition: YOUTUBE_PLATFORM_DEFINITION });
  singleton = registry;
  return registry;
}

export function resolveLivePublishingTarget(account: LivePublishAccount) {
  return getPlatformRegistry().selectLiveAdapter(account);
}

function baseAccountReady(account: LivePublishAccount) {
  return account.isSelected
    && account.publishCapability === "VERIFIED"
    && Boolean(account.externalAccountId);
}

function oauthConnectionReady(account: LivePublishAccount, provider: Provider) {
  return account.connection?.provider === provider
    && account.connection.status === "CONNECTED"
    && account.hasEncryptedAccessToken;
}
