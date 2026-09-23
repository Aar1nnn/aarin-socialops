import type { Provider } from "@prisma/client";
import { AppError } from "../errors";
import { redactSensitiveText } from "../token-vault";
import {
  PlatformAuthError,
  type AccountDiscovery,
  type AuthTokenSet,
  type AuthorizationRequest,
  type DiscoveredPlatformAccount,
  type PlatformAuthAdapter,
} from "./platform-auth";

type MetaAuthConfig = {
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  redirectUri: string;
  scopes: string[];
  loginConfigurationId?: string;
  authBaseUrl?: string;
  graphBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type MetaAccount = {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string; name?: string };
};

export const REQUIRED_META_CONNECTION_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_read_user_content",
] as const;

export const DEFAULT_META_SCOPES = [
  ...REQUIRED_META_CONNECTION_SCOPES,
  "instagram_basic",
  "instagram_content_publish",
];

export class MetaAuthAdapter implements PlatformAuthAdapter {
  readonly provider: Provider = "META";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: MetaAuthConfig) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
      throw new AppError("Meta OAuth 应用配置不完整。", 503, "META_OAUTH_NOT_CONFIGURED");
    }
    this.fetchImpl = config.fetchImpl || fetch;
  }

  buildAuthorizationUrl(request: AuthorizationRequest): URL {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new AppError("OAuth redirect URI 与服务器配置不一致。", 400, "OAUTH_REDIRECT_URI_MISMATCH");
    }
    const base = (this.config.authBaseUrl || "https://www.facebook.com").replace(/\/$/, "");
    const url = new URL(`${base}/${this.config.apiVersion}/dialog/oauth`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("state", request.state);
    url.searchParams.set("response_type", "code");
    if (this.config.loginConfigurationId) {
      url.searchParams.set("config_id", this.config.loginConfigurationId);
      url.searchParams.set("override_default_response_type", "true");
    } else {
      url.searchParams.set("scope", this.config.scopes.join(","));
    }
    if (request.codeChallenge) {
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url;
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<AuthTokenSet> {
    if (!code || redirectUri !== this.config.redirectUri) {
      throw new PlatformAuthError("INVALID_OAUTH_CALLBACK", "授权码或 redirect URI 无效。", 400);
    }
    const form = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    if (codeVerifier) form.set("code_verifier", codeVerifier);
    const data = await this.requestJson<{ access_token?: string; expires_in?: number }>(
      `${this.graphBaseUrl()}/${this.config.apiVersion}/oauth/access_token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form },
    );
    if (!data.access_token) throw new PlatformAuthError("META_TOKEN_MISSING", "Meta token 响应缺少 access_token。", 502);
    return {
      accessToken: data.access_token,
      accessTokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      scopes: [],
    };
  }

  async discoverAccounts(accessToken: string): Promise<AccountDiscovery> {
    const headers = { authorization: `Bearer ${accessToken}` };
    const [profile, permissions, pages] = await Promise.all([
      this.requestJson<{ id?: string }>(`${this.graphBaseUrl()}/${this.config.apiVersion}/me?fields=id`, { headers }),
      this.requestJson<{ data?: Array<{ permission: string; status: string }> }>(`${this.graphBaseUrl()}/${this.config.apiVersion}/me/permissions`, { headers }),
      this.requestJson<{ data?: MetaAccount[] }>(
        `${this.graphBaseUrl()}/${this.config.apiVersion}/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username,name}`,
        { headers },
      ),
    ]);
    if (!profile.id) throw new PlatformAuthError("META_PRINCIPAL_MISSING", "Meta 未返回授权主体 ID。", 502);
    const grantedScopes = (permissions.data || [])
      .filter((entry) => entry.status === "granted")
      .map((entry) => entry.permission);
    const accounts = (pages.data || []).flatMap((page) => this.mapPage(page, grantedScopes));
    return { externalPrincipalId: profile.id, grantedScopes, accounts };
  }

  async revoke(accessToken: string): Promise<void> {
    await this.requestJson(`${this.graphBaseUrl()}/${this.config.apiVersion}/me/permissions`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  private mapPage(page: MetaAccount, grantedScopes: string[]): DiscoveredPlatformAccount[] {
    if (!page.id || !page.name || !page.access_token) return [];
    const tasks = normalizePageTasks(page.tasks || []);
    const canPublish = hasMetaCapability(tasks, "CREATE_CONTENT") && grantedScopes.includes("pages_manage_posts");
    const canRead = grantedScopes.includes("pages_read_engagement");
    const canReadUserContent = grantedScopes.includes("pages_read_user_content");
    const facebook: DiscoveredPlatformAccount = {
      externalAccountId: page.id,
      platform: "facebook",
      accountType: "FACEBOOK_PAGE",
      displayName: page.name,
      accessToken: page.access_token,
      capabilities: {
        pageTasks: tasks,
        canPublish,
        canReadMetrics: hasMetaCapability(tasks, "ANALYZE") && canRead,
        canReadComments: hasMetaCapability(tasks, "MODERATE") && canRead && canReadUserContent,
      },
      metadata: { source: "meta-account-discovery" },
    };
    if (!page.instagram_business_account?.id) return [facebook];
    const instagram: DiscoveredPlatformAccount = {
      externalAccountId: page.instagram_business_account.id,
      platform: "instagram",
      accountType: "INSTAGRAM_PROFESSIONAL",
      displayName: page.instagram_business_account.name || page.instagram_business_account.username || `Instagram ${page.instagram_business_account.id}`,
      username: page.instagram_business_account.username,
      accessToken: page.access_token,
      capabilities: {
        linkedFacebookPageId: page.id,
        canPublish: canPublish
          && grantedScopes.includes("instagram_basic")
          && grantedScopes.includes("instagram_content_publish"),
        canQueryStatus: grantedScopes.includes("instagram_basic"),
      },
      metadata: { source: "meta-account-discovery", linkedFacebookPageId: page.id },
    };
    return [facebook, instagram];
  }

  private graphBaseUrl() {
    return (this.config.graphBaseUrl || "https://graph.facebook.com").replace(/\/$/, "");
  }

  private async requestJson<T = Record<string, unknown>>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 30_000);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || payload.error) {
        const graphError = payload.error as { message?: string; code?: number; type?: string } | undefined;
        throw new PlatformAuthError(
          graphError?.code ? `META_${graphError.code}` : "META_AUTH_API_ERROR",
          redactSensitiveText(graphError?.message || `Meta OAuth HTTP ${response.status}`),
          response.status || 502,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof PlatformAuthError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlatformAuthError("META_AUTH_TIMEOUT", "Meta OAuth 请求超时。", 504);
      }
      throw new PlatformAuthError("META_AUTH_NETWORK_ERROR", "无法连接 Meta OAuth 服务。", 502);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createMetaAuthAdapter() {
  return new MetaAuthAdapter({
    clientId: process.env.META_APP_ID || process.env.META_CLIENT_ID || "",
    clientSecret: process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET || "",
    redirectUri: process.env.META_REDIRECT_URI || "",
    apiVersion: process.env.META_GRAPH_API_VERSION || process.env.FACEBOOK_GRAPH_API_VERSION || "v26.0",
    scopes: parseScopes(process.env.META_OAUTH_SCOPES),
    loginConfigurationId: process.env.META_LOGIN_CONFIG_ID,
    authBaseUrl: process.env.META_AUTH_BASE_URL,
    graphBaseUrl: process.env.META_GRAPH_BASE_URL || process.env.FACEBOOK_GRAPH_BASE_URL,
    timeoutMs: Number(process.env.META_REQUEST_TIMEOUT_MS || 30_000),
  });
}

function parseScopes(raw?: string) {
  return raw ? raw.split(",").map((scope) => scope.trim()).filter(Boolean) : DEFAULT_META_SCOPES;
}

export type CanonicalMetaCapability = "CREATE_CONTENT" | "ANALYZE" | "MODERATE";

export function normalizeMetaTask(task: string) {
  return task.trim().toUpperCase().replace(/^PROFILE_PLUS_/, "");
}

export function normalizePageTasks(tasks: string[]) {
  return [...new Set(tasks.map(normalizeMetaTask).filter(Boolean))];
}

export function hasMetaCapability(tasks: string[], capability: CanonicalMetaCapability) {
  return normalizePageTasks(tasks).includes(capability);
}
