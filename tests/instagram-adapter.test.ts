import { describe, expect, it, vi } from "vitest";
import { InstagramGraphAdapter } from "../src/lib/adapters/instagram-graph";
import type { PublishRequest } from "../src/lib/adapters/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    clientId: "client-a",
    platform: "instagram",
    accountExternalId: "ig-1",
    text: "Aarin Instagram acceptance candidate",
    assets: [{ storageProvider: "s3", storageKey: "client-a/photo.jpg", mimeType: "image/jpeg", originalName: "photo.jpg" }],
    idempotencyKey: "one",
    ...overrides,
  };
}

function adapter(
  fetchImpl: typeof fetch,
  resolveAssetUrl: (asset: PublishRequest["assets"][number]) => Promise<string | null> = async () => "https://cdn.example.test/photo.jpg",
) {
  return new InstagramGraphAdapter({
    igUserId: "ig-1",
    accessToken: "secret-page-token",
    apiVersion: "v26.0",
    baseUrl: "https://graph.example.test",
    fetchImpl,
    pollIntervalMs: 0,
    pollMaxAttempts: 2,
    resolveAssetUrl,
  });
}

describe("InstagramGraphAdapter", () => {
  it("publishes an image container, publishes it, and confirms the remote media", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method || "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        body: String(init?.body || ""),
      });
      if (url.endsWith("/ig-1/media")) return jsonResponse({ id: "container-1" });
      if (url.endsWith("/ig-1/media_publish")) return jsonResponse({ id: "media-1" });
      return jsonResponse({ id: "media-1", permalink: "https://www.instagram.com/p/media-1/", timestamp: "2026-09-21T01:02:03Z" });
    }) as typeof fetch;

    const result = await adapter(fetchImpl).publish(request());
    expect(result).toMatchObject({
      status: "published",
      remotePostId: "media-1",
      remotePostUrl: "https://www.instagram.com/p/media-1/",
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "GET"]);
    expect(calls[0].body).toContain("image_url=https%3A%2F%2Fcdn.example.test%2Fphoto.jpg");
    expect(calls[0].body).toContain("caption=Aarin+Instagram+acceptance+candidate");
    expect(calls.every((call) => call.authorization === "Bearer secret-page-token")).toBe(true);
    expect(calls.every((call) => !call.url.includes("secret-page-token"))).toBe(true);
  });

  it("waits for video processing before publishing", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.endsWith("/ig-1/media")) return jsonResponse({ id: "video-container" });
      if (url.includes("video-container?fields=status_code")) return jsonResponse({ id: "video-container", status_code: "FINISHED" });
      if (url.endsWith("/ig-1/media_publish")) return jsonResponse({ id: "video-media" });
      return jsonResponse({ id: "video-media", permalink: "https://www.instagram.com/reel/video-media/" });
    }) as typeof fetch;
    const result = await adapter(fetchImpl, async () => "https://cdn.example.test/video.mp4").publish(request({
      assets: [{ storageProvider: "s3", storageKey: "video.mp4", mimeType: "video/mp4", originalName: "video.mp4" }],
    }));
    expect(result).toMatchObject({ status: "published", remotePostId: "video-media" });
    expect(calls.some((call) => call.includes("video-container?fields=status_code"))).toBe(true);
  });

  it("builds a carousel from independently prepared children", async () => {
    let child = 0;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      bodies.push(String(init?.body || ""));
      if (url.endsWith("/ig-1/media")) {
        child += 1;
        return jsonResponse({ id: child <= 2 ? `child-${child}` : "parent-1" });
      }
      if (url.endsWith("/ig-1/media_publish")) return jsonResponse({ id: "carousel-media" });
      return jsonResponse({ id: "carousel-media" });
    }) as typeof fetch;
    const result = await adapter(fetchImpl, async (asset) => `https://cdn.example.test/${asset.originalName}`).publish(request({
      assets: [
        { storageProvider: "s3", storageKey: "one.jpg", mimeType: "image/jpeg", originalName: "one.jpg" },
        { storageProvider: "s3", storageKey: "two.png", mimeType: "image/png", originalName: "two.png" },
      ],
    }));
    expect(result).toMatchObject({ status: "published", remotePostId: "carousel-media" });
    expect(bodies.some((body) => body.includes("media_type=CAROUSEL") && body.includes("children=child-1%2Cchild-2"))).toBe(true);
  });

  it("rejects missing, unsupported, or non-public media before dispatch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "must-not-run" })) as typeof fetch;
    await expect(adapter(fetchImpl).publish(request({ assets: [] }))).resolves.toMatchObject({
      status: "failed", code: "MEDIA_INVALID", failurePhase: "PRE_DISPATCH",
    });
    await expect(adapter(fetchImpl).publish(request({ assets: [
      { storageProvider: "s3", storageKey: "doc.pdf", mimeType: "application/pdf", originalName: "doc.pdf" },
    ] }))).resolves.toMatchObject({ status: "failed", code: "MEDIA_INVALID", failurePhase: "PRE_DISPATCH" });
    await expect(adapter(fetchImpl, async () => null).publish(request())).resolves.toMatchObject({
      status: "failed", code: "MEDIA_URL_UNAVAILABLE", failurePhase: "PRE_DISPATCH",
    });
    await expect(adapter(fetchImpl, async () => "http://localhost/file.jpg").publish(request())).resolves.toMatchObject({
      status: "failed", code: "MEDIA_URL_UNAVAILABLE", failurePhase: "PRE_DISPATCH",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [190, 400, "TOKEN_INVALID"],
    [200, 403, "PERMISSION_DENIED"],
    [4, 429, "RATE_LIMITED"],
    [368, 400, "CONTENT_REJECTED"],
    [324, 400, "MEDIA_INVALID"],
  ])("maps an explicit Meta error %s to %s", async (graphCode, httpStatus, expectedCode) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: graphCode, message: "provider rejection" } }, httpStatus)) as typeof fetch;
    const result = await adapter(fetchImpl).publish(request());
    expect(result).toMatchObject({ status: "failed", code: expectedCode, retryable: false, failurePhase: "POST_DISPATCH" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns UNKNOWN and performs no hidden retry after a mutating timeout or 5xx", async () => {
    const timeoutFetch = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    await expect(adapter(timeoutFetch).publish(request())).resolves.toMatchObject({ status: "unknown", code: "NETWORK_TIMEOUT" });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const serverFetch = vi.fn(async () => jsonResponse({ error: { code: 2, message: "server" } }, 503)) as typeof fetch;
    await expect(adapter(serverFetch).publish(request())).resolves.toMatchObject({ status: "unknown", code: "REMOTE_RESULT_UNKNOWN" });
    expect(serverFetch).toHaveBeenCalledTimes(1);
  });
});
