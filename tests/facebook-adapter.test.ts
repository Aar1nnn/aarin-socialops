import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FacebookGraphAdapter, classifyFacebookError } from "../src/lib/adapters/facebook-graph";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("FacebookGraphAdapter", () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "socialops-facebook-"));
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
  });

  afterEach(async () => {
    delete process.env.STORAGE_LOCAL_ROOT;
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("validates the Page identity, tasks and granted permissions without putting the token in the URL", async () => {
    const urls: string[] = [];
    const adapter = new FacebookGraphAdapter({
      pageId: "123",
      accessToken: "server-secret-token",
      apiVersion: "v26.0",
      fetchImpl: async (input, init) => {
        urls.push(String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret-token");
        if (String(input).endsWith("/123?fields=id,name,tasks")) return jsonResponse({ id: "123", name: "Test Page", tasks: ["CREATE_CONTENT", "MODERATE", "ANALYZE"] });
        return jsonResponse({ data: [{ permission: "pages_manage_posts", status: "granted" }, { permission: "pages_read_engagement", status: "granted" }] });
      },
    });
    const result = await adapter.validateConnection();
    expect(result.pageName).toBe("Test Page");
    expect(result.pageTasks).toContain("CREATE_CONTENT");
    expect(result.grantedPermissions).toContain("pages_manage_posts");
    expect(urls.join(" ")).not.toContain("server-secret-token");
  });

  it("publishes text and confirms the returned remote post", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const adapter = new FacebookGraphAdapter({
      pageId: "123",
      accessToken: "secret",
      apiVersion: "v26.0",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method || "GET", body: init?.body });
        if (init?.method === "POST") return jsonResponse({ id: "123_456" });
        return jsonResponse({ id: "123_456", created_time: "2026-09-17T01:02:03+0000", permalink_url: "https://www.facebook.com/123/posts/456", is_published: true });
      },
    });
    const result = await adapter.publish({ clientId: "c1", platform: "facebook", accountExternalId: "123", text: "[TEST] wholesale chair", assets: [], idempotencyKey: "once" });
    expect(result).toMatchObject({ status: "published", remotePostId: "123_456", remotePostUrl: "https://www.facebook.com/123/posts/456" });
    expect(calls[0].url).toContain("/123/feed");
    expect(calls[0].body).toBeInstanceOf(URLSearchParams);
  });

  it.each([
    ["image", "image/png", "test.png", "photos", "caption"],
    ["video", "video/mp4", "test.mp4", "videos", "description"],
  ])("publishes one %s with copy", async (_kind, mimeType, originalName, endpoint, copyField) => {
    await writeFile(join(storageRoot, originalName), Buffer.from("test-media"));
    let multipart = "";
    const adapter = new FacebookGraphAdapter({
      pageId: "123",
      accessToken: "secret",
      apiVersion: "v26.0",
      fetchImpl: async (input, init) => {
        if (init?.method === "POST") {
          expect(String(input)).toContain(`/123/${endpoint}`);
          const chunks: Buffer[] = [];
          for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
          multipart = Buffer.concat(chunks).toString("utf8");
          return jsonResponse(endpoint === "photos" ? { id: "photo", post_id: "123_789" } : { id: "video789" });
        }
        return jsonResponse({ id: endpoint === "photos" ? "123_789" : "video789", is_published: true });
      },
    });
    const result = await adapter.publish({ clientId: "c1", platform: "facebook", accountExternalId: "123", text: "[TEST] media", assets: [{ storageKey: originalName, mimeType, originalName }], idempotencyKey: endpoint });
    expect(result.status).toBe("published");
    expect(multipart).toContain(`name="${copyField}"`);
    expect(multipart).toContain("[TEST] media");
    expect(multipart).toContain('name="source"');
    expect(multipart).toContain("test-media");
  });

  it("returns UNKNOWN on a timeout and never turns it into a retryable failure", async () => {
    const adapter = new FacebookGraphAdapter({ pageId: "123", accessToken: "secret", apiVersion: "v26.0", fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); } });
    const result = await adapter.publish({ clientId: "c1", platform: "facebook", accountExternalId: "123", text: "[TEST] timeout", assets: [], idempotencyKey: "timeout" });
    expect(result).toEqual({ status: "unknown", code: "NETWORK_TIMEOUT", message: "Facebook 请求超时，远端结果可能未知。" });
  });

  it("treats a server error after dispatch as UNKNOWN instead of retrying a possible duplicate", async () => {
    const adapter = new FacebookGraphAdapter({ pageId: "123", accessToken: "secret", apiVersion: "v26.0", fetchImpl: async () => jsonResponse({ error: { code: 2, message: "temporary server failure" } }, 500) });
    const result = await adapter.publish({ clientId: "c1", platform: "facebook", accountExternalId: "123", text: "[TEST] uncertain 500", assets: [], idempotencyKey: "server-500" });
    expect(result.status).toBe("unknown");
    expect(result).toMatchObject({ code: "REMOTE_RESULT_UNKNOWN" });
  });

  it("keeps the remote ID but stays UNKNOWN while a created video is not confirmed published", async () => {
    await writeFile(join(storageRoot, "processing.mp4"), Buffer.from("test-video"));
    const adapter = new FacebookGraphAdapter({
      pageId: "123",
      accessToken: "secret",
      apiVersion: "v26.0",
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") {
          for await (const _chunk of init.body as unknown as AsyncIterable<Uint8Array>) { /* consume the upload stream */ }
          return jsonResponse({ id: "video-processing-1" });
        }
        return jsonResponse({ id: "video-processing-1", is_published: false });
      },
    });
    const result = await adapter.publish({ clientId: "c1", platform: "facebook", accountExternalId: "123", text: "[TEST] processing", assets: [{ storageKey: "processing.mp4", mimeType: "video/mp4", originalName: "processing.mp4" }], idempotencyKey: "processing" });
    expect(result).toMatchObject({ status: "unknown", remotePostId: "video-processing-1", code: "REMOTE_NOT_PUBLISHED" });
  });

  it("classifies token, permission, rate limit, content and media errors", () => {
    expect(classifyFacebookError({ error: { code: 190, message: "expired" } }, 400).category).toBe("TOKEN_INVALID");
    expect(classifyFacebookError({ error: { code: 200, message: "denied" } }, 403).category).toBe("PERMISSION_DENIED");
    expect(classifyFacebookError({ error: { code: 4, message: "limited" } }, 429).category).toBe("RATE_LIMITED");
    expect(classifyFacebookError({ error: { code: 368, message: "rejected" } }, 400).category).toBe("CONTENT_REJECTED");
    expect(classifyFacebookError({ error: { code: 324, message: "bad media" } }, 400).category).toBe("MEDIA_INVALID");
  });

  it("keeps a real numeric zero and imports public comment fields", async () => {
    const adapter = new FacebookGraphAdapter({
      pageId: "123",
      accessToken: "secret",
      apiVersion: "v26.0",
      fetchImpl: async (input) => String(input).includes("/insights?")
        ? jsonResponse({ data: [{ name: "page_test_metric", values: [{ value: 0, end_time: "2026-09-17T00:00:00+0000" }] }] })
        : jsonResponse({ data: [{ id: "comment-1", message: "MOQ and catalog?", from: { id: "buyer-1", name: "Buyer" }, created_time: "2026-09-17T01:00:00+0000", permalink_url: "https://facebook.test/comment-1" }], paging: { cursors: { after: "next" }, next: "next-url" } }),
    });
    expect(await adapter.readMetrics(["page_test_metric"])).toMatchObject([{ metricKey: "page_test_metric", value: 0 }]);
    const comments = await adapter.readComments("123_456");
    expect(comments.comments[0]).toMatchObject({ id: "comment-1", message: "MOQ and catalog?", authorId: "buyer-1" });
    expect(comments.nextCursor).toBe("next");
  });

  it("reads real post comment and reaction totals, including zero", async () => {
    const adapter = new FacebookGraphAdapter({ pageId: "123", accessToken: "secret", apiVersion: "v26.0", fetchImpl: async () => jsonResponse({ comments: { summary: { total_count: 0 } }, reactions: { summary: { total_count: 2 } } }) });
    expect(await adapter.readPostMetrics("123_456")).toEqual([
      { metricKey: "post_comments_total", value: 0 },
      { metricKey: "post_reactions_total", value: 2 },
    ]);
  });
});
