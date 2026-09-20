import { describe, expect, it } from "vitest";
import { AdapterNotRegisteredError, AdapterRegistry } from "../src/lib/adapters/registry";
import { resolvePublishAdapter } from "../src/services/publish-adapter-service";

describe("AdapterRegistry", () => {
  it("resolves by provider, platform and capability", async () => {
    const registry = new AdapterRegistry<{ name: string }>();
    registry.register({ provider: "META", platform: "facebook", capability: "PUBLISH" }, async () => ({ name: "meta-facebook" }));
    await expect(registry.resolve({ provider: "META", platform: "facebook", capability: "PUBLISH" })).resolves.toEqual({ name: "meta-facebook" });
  });

  it("returns an explicit unsupported error instead of falling back", async () => {
    const registry = new AdapterRegistry();
    await expect(registry.resolve({ provider: "LINKEDIN", platform: "linkedin", capability: "PUBLISH" })).rejects.toBeInstanceOf(AdapterNotRegisteredError);
  });

  it("rejects an unknown Meta adapter instead of silently using the legacy connection", async () => {
    await expect(
      resolvePublishAdapter({
        clientId: "client-a",
        accountId: "account-a",
        provider: "META",
        platform: "facebook",
        adapter: "unexpected-adapter",
        account: { platform: "facebook" },
      } as never),
    ).rejects.toMatchObject({ code: "ADAPTER_NOT_REGISTERED" });
  });
});
