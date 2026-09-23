import { describe, expect, it, vi } from "vitest";
import { FACEBOOK_PLATFORM_DEFINITION } from "../src/lib/platforms/capabilities";
import { normalizeMetaGraphFailure, PlatformHttpError } from "../src/lib/platforms/errors";
import { requestPlatformJson } from "../src/lib/platforms/http-client";
import { PlatformNotRegisteredError, PlatformRegistry } from "../src/lib/platforms/registry";
import { getPlatformRegistry, resolveLivePublishingTarget } from "../src/services/platform-registry-service";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Platform Foundation", () => {
  it("registers one provider/platform definition and rejects duplicates", () => {
    const registry = new PlatformRegistry();
    registry.register({ definition: FACEBOOK_PLATFORM_DEFINITION });
    expect(registry.get("META", "FACEBOOK").definition.platform).toBe("facebook");
    expect(() => registry.register({ definition: FACEBOOK_PLATFORM_DEFINITION })).toThrow(
      "DUPLICATE_PLATFORM_REGISTRATION:META:facebook",
    );
    expect(() => registry.get("LINKEDIN", "linkedin")).toThrow(PlatformNotRegisteredError);
  });

  it("declares future platforms while selecting only a verified Instagram OAuth target", () => {
    expect(getPlatformRegistry().listDefinitions().map((definition) => definition.platform)).toEqual(
      expect.arrayContaining(["facebook", "instagram", "linkedin", "tiktok", "youtube"]),
    );
    const connected = {
      platform: "instagram",
      accountType: "INSTAGRAM_PROFESSIONAL",
      isSelected: true,
      publishCapability: "VERIFIED",
      externalAccountId: "ig-1",
      hasEncryptedAccessToken: true,
      connection: { provider: "META" as const, status: "CONNECTED" },
    };
    expect(resolveLivePublishingTarget(connected)).toEqual({
      provider: "META",
      platform: "instagram",
      adapterName: "meta-instagram",
    });
    expect(resolveLivePublishingTarget({ ...connected, isSelected: false })).toBeNull();
    expect(resolveLivePublishingTarget({ ...connected, publishCapability: "UNVERIFIED" })).toBeNull();
  });

  it("never retries a mutating request after an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 2, message: "server" } }, 503));
    await expect(
      requestPlatformJson("https://platform.example.test/publish", {
        method: "POST",
        body: new URLSearchParams({ value: "one" }),
        fetchImpl,
        failurePhase: "POST_DISPATCH",
      }),
    ).rejects.toMatchObject({ kind: "HTTP", status: 503, failurePhase: "POST_DISPATCH" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows bounded retry only for an explicitly safe read", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: "remote-1" }));
    await expect(
      requestPlatformJson<{ id: string }>("https://platform.example.test/remote-1", {
        method: "GET",
        retryMode: "SAFE_READS",
        baseDelayMs: 0,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ body: { id: "remote-1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps explicit Meta errors separately from post-dispatch uncertainty", () => {
    const token = normalizeMetaGraphFailure(
      new PlatformHttpError("HTTP", "denied", "POST_DISPATCH", 400, { error: { code: 190, message: "expired" } }),
      "POST_DISPATCH",
    );
    expect(token).toMatchObject({ code: "TOKEN_INVALID", uncertain: false, retryable: false });

    const rateLimit = normalizeMetaGraphFailure(
      new PlatformHttpError("HTTP", "limited", "POST_DISPATCH", 429, { error: { code: 4, message: "limited" } }),
      "POST_DISPATCH",
    );
    expect(rateLimit).toMatchObject({ code: "RATE_LIMITED", uncertain: false, retryable: false });

    const server = normalizeMetaGraphFailure(
      new PlatformHttpError("HTTP", "server", "POST_DISPATCH", 503, { error: { code: 2, message: "server" } }),
      "POST_DISPATCH",
    );
    expect(server).toMatchObject({ code: "REMOTE_RESULT_UNKNOWN", uncertain: true, retryable: false });
  });
});
