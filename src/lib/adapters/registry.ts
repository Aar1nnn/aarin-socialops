import type { Provider } from "@prisma/client";

export type AdapterCapability = "PUBLISH" | "METRICS" | "COMMENTS" | "AUTH";

export type AdapterRegistryKey = {
  provider: Provider;
  platform: string;
  capability: AdapterCapability;
};

export class AdapterNotRegisteredError extends Error {
  readonly code = "ADAPTER_NOT_REGISTERED";
  constructor(readonly key: AdapterRegistryKey) {
    super(`未注册 ${key.provider}/${key.platform}/${key.capability} 适配器。`);
    this.name = "AdapterNotRegisteredError";
  }
}

export class AdapterRegistry<T> {
  private readonly factories = new Map<string, () => Promise<T>>();

  register(key: AdapterRegistryKey, factory: () => Promise<T>) {
    const registryKey = serializeKey(key);
    if (this.factories.has(registryKey)) throw new Error(`DUPLICATE_ADAPTER_REGISTRATION:${registryKey}`);
    this.factories.set(registryKey, factory);
  }

  has(key: AdapterRegistryKey) {
    return this.factories.has(serializeKey(key));
  }

  async resolve(key: AdapterRegistryKey) {
    const factory = this.factories.get(serializeKey(key));
    if (!factory) throw new AdapterNotRegisteredError(key);
    return factory();
  }
}

function serializeKey(key: AdapterRegistryKey) {
  return `${key.provider}:${key.platform.toLowerCase()}:${key.capability}`;
}
