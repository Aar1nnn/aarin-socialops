import type { Provider } from "@prisma/client";
import type { SocialPublishAdapter } from "../adapters/types";
import type { PlatformDefinition } from "./capabilities";

export type PublishAdapterResolution = {
  clientId: string;
  accountId: string;
  adapterName: string;
};

export type LivePublishAccount = {
  platform: string;
  accountType: string | null;
  isSelected: boolean;
  publishCapability: string;
  externalAccountId: string | null;
  hasEncryptedAccessToken: boolean;
  connection: { provider: Provider; status: string } | null;
  legacyFacebook?: {
    connectionStatus: string;
    tokenStatus: string;
    pageId: string;
  } | null;
};

export type PlatformRegistration = {
  definition: PlatformDefinition;
  createPublishAdapter?: (input: PublishAdapterResolution) => Promise<SocialPublishAdapter>;
  selectLiveAdapter?: (account: LivePublishAccount) => string | null;
};

export class PlatformNotRegisteredError extends Error {
  readonly code = "PLATFORM_NOT_REGISTERED";
  constructor(readonly provider: Provider, readonly platform: string) {
    super(`未注册 ${provider}/${platform} 平台。`);
    this.name = "PlatformNotRegisteredError";
  }
}

export class PlatformRegistry {
  private readonly registrations = new Map<string, PlatformRegistration>();

  register(registration: PlatformRegistration) {
    const key = serialize(registration.definition.provider, registration.definition.platform);
    if (this.registrations.has(key)) throw new Error(`DUPLICATE_PLATFORM_REGISTRATION:${key}`);
    this.registrations.set(key, registration);
  }

  get(provider: Provider, platform: string) {
    const registration = this.registrations.get(serialize(provider, platform));
    if (!registration) throw new PlatformNotRegisteredError(provider, platform);
    return registration;
  }

  getByPlatform(platform: string) {
    const matches = [...this.registrations.values()].filter(
      (registration) => registration.definition.platform === platform.toLowerCase(),
    );
    if (matches.length !== 1) return null;
    return matches[0];
  }

  listDefinitions() {
    return [...this.registrations.values()].map((registration) => registration.definition);
  }

  async resolvePublishAdapter(provider: Provider, platform: string, input: PublishAdapterResolution) {
    const registration = this.get(provider, platform);
    if (!registration.createPublishAdapter) {
      throw new PlatformNotRegisteredError(provider, `${platform}/PUBLISH`);
    }
    if (!registration.definition.supportedPublishAdapters.includes(input.adapterName)) {
      throw new Error(`ADAPTER_NOT_REGISTERED:${provider}:${platform}:${input.adapterName}`);
    }
    return registration.createPublishAdapter(input);
  }

  selectLiveAdapter(account: LivePublishAccount) {
    const registration = this.getByPlatform(account.platform);
    if (!registration?.selectLiveAdapter) return null;
    const adapterName = registration.selectLiveAdapter(account);
    if (!adapterName || !registration.definition.supportedPublishAdapters.includes(adapterName)) return null;
    return {
      provider: registration.definition.provider,
      platform: registration.definition.platform,
      adapterName,
    };
  }
}

function serialize(provider: Provider, platform: string) {
  return `${provider}:${platform.toLowerCase()}`;
}
