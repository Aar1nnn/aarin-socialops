import { describe, expect, it } from "vitest";
import { hasMetaCapability, MetaAuthAdapter, normalizeMetaTask, normalizePageTasks } from "../src/lib/adapters/meta-auth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MetaAuthAdapter", () => {
  it("builds a state-bound authorization URL without app secret", () => {
    const adapter = new MetaAuthAdapter({
      clientId: "client-id",
      clientSecret: "never-in-url",
      apiVersion: "v26.0",
      redirectUri: "https://app.example.test/api/connections/meta/callback",
      scopes: ["pages_show_list", "pages_manage_posts"],
    });
    const url = adapter.buildAuthorizationUrl({ state: "csrf-state", redirectUri: "https://app.example.test/api/connections/meta/callback" });
    expect(url.searchParams.get("state")).toBe("csrf-state");
    expect(url.searchParams.get("scope")).toContain("pages_show_list");
    expect(url.toString()).not.toContain("never-in-url");
  });

  it("exchanges a code and discovers Page plus linked Instagram without leaking the user token into URLs", async () => {
    const seen: Array<{ url: string; authorization: string | null; body: string }> = [];
    const adapter = new MetaAuthAdapter({
      clientId: "client-id",
      clientSecret: "app-secret",
      apiVersion: "v26.0",
      redirectUri: "https://app.example.test/api/connections/meta/callback",
      scopes: ["pages_show_list"],
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({ url, authorization: headers.get("authorization"), body: String(init?.body || "") });
        if (url.includes("oauth/access_token")) return jsonResponse({ access_token: "user-access-token", expires_in: 3600 });
        if (url.includes("/me/permissions")) return jsonResponse({ data: [
          { permission: "pages_show_list", status: "granted" },
          { permission: "pages_manage_posts", status: "granted" },
          { permission: "pages_read_engagement", status: "granted" },
          { permission: "pages_read_user_content", status: "granted" },
        ] });
        if (url.includes("/me/accounts")) return jsonResponse({ data: [{
          id: "page-1", name: "Test Page", access_token: "page-access-token",
          tasks: ["PROFILE_PLUS_CREATE_CONTENT", "PROFILE_PLUS_ANALYZE", "PROFILE_PLUS_MODERATE"],
          instagram_business_account: { id: "ig-1", username: "testbrand" },
        }] });
        return jsonResponse({ id: "person-1" });
      },
    });
    const token = await adapter.exchangeCode("one-time-code", "https://app.example.test/api/connections/meta/callback");
    const discovery = await adapter.discoverAccounts(token.accessToken);
    expect(discovery.externalPrincipalId).toBe("person-1");
    expect(discovery.accounts.map((account) => account.accountType)).toEqual(["FACEBOOK_PAGE", "INSTAGRAM_PROFESSIONAL"]);
    expect(discovery.accounts[0].capabilities).toMatchObject({ canPublish: true, canReadMetrics: true, canReadComments: true });
    expect(seen.filter((request) => request.url.includes("/me")).every((request) => !request.url.includes("user-access-token"))).toBe(true);
    expect(seen.filter((request) => request.url.includes("/me")).every((request) => request.authorization === "Bearer user-access-token")).toBe(true);
    expect(seen.find((request) => request.url.includes("oauth/access_token"))?.body).toContain("client_secret=app-secret");
  });

  it("normalizes current PROFILE_PLUS task names", () => {
    expect(normalizePageTasks(["PROFILE_PLUS_CREATE_CONTENT", "ANALYZE"])).toEqual(["CREATE_CONTENT", "ANALYZE"]);
    expect(normalizeMetaTask("CREATE_CONTENT")).toBe("CREATE_CONTENT");
    expect(normalizeMetaTask("PROFILE_PLUS_CREATE_CONTENT")).toBe("CREATE_CONTENT");
    expect(hasMetaCapability(["PROFILE_PLUS_CREATE_CONTENT"], "CREATE_CONTENT")).toBe(true);
  });
});
