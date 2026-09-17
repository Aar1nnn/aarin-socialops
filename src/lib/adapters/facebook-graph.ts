import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolveLocalAssetPath } from "./storage";
import type { PublishRequest, PublishResult, SocialPublishAdapter } from "./types";

export type FacebookErrorCategory =
  | "TOKEN_INVALID"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "CONTENT_REJECTED"
  | "MEDIA_INVALID"
  | "NETWORK_TIMEOUT"
  | "REMOTE_RESULT_UNKNOWN"
  | "REMOTE_NOT_FOUND"
  | "API_ERROR";

export const FACEBOOK_ERROR_ADVICE: Record<FacebookErrorCategory, string> = {
  TOKEN_INVALID: "重新生成 Page access token，并在服务器更新对应环境变量后重新验证连接。",
  PERMISSION_DENIED: "检查 Meta App 权限、Page 任务和 App 模式；补齐权限后重新验证。",
  RATE_LIMITED: "暂停执行并等待限流窗口恢复；不要反复点击发布。",
  CONTENT_REJECTED: "在 Meta 后台查看内容政策或审核原因，修改内容后重新走人工审批。",
  MEDIA_INVALID: "检查文件格式、大小、编码和 Page 支持范围，替换素材后重新审批。",
  NETWORK_TIMEOUT: "请求结果不确定；先查询远端帖子或在 Meta 后台人工对账，禁止直接重发。",
  REMOTE_RESULT_UNKNOWN: "远端结果无法确认；保留 UNKNOWN 并人工核对 Page 后台。",
  REMOTE_NOT_FOUND: "远端 ID 不存在或当前令牌不可见；核对 Page、令牌和帖子 ID。",
  API_ERROR: "记录 Meta 错误代码并检查 Graph API 状态；确认失败原因后再决定是否重试。",
};

type GraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
};

export class FacebookGraphError extends Error {
  constructor(
    public readonly category: FacebookErrorCategory,
    message: string,
    public readonly retryable: boolean,
    public readonly graphCode?: number,
    public readonly graphSubcode?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export function classifyFacebookError(body: GraphErrorBody, httpStatus: number): FacebookGraphError {
  const error = body.error;
  const code = error?.code;
  const subcode = error?.error_subcode;
  const message = error?.error_user_msg || error?.message || `Facebook Graph API HTTP ${httpStatus}`;
  if (code === 190) return new FacebookGraphError("TOKEN_INVALID", message, false, code, subcode, httpStatus);
  if (code === 10 || code === 200 || code === 299) return new FacebookGraphError("PERMISSION_DENIED", message, false, code, subcode, httpStatus);
  if (code === 4 || code === 17 || code === 32 || code === 613 || httpStatus === 429) return new FacebookGraphError("RATE_LIMITED", message, true, code, subcode, httpStatus);
  if (code === 368 || code === 506) return new FacebookGraphError("CONTENT_REJECTED", message, false, code, subcode, httpStatus);
  if (code === 324 || code === 352 || code === 360 || code === 361) return new FacebookGraphError("MEDIA_INVALID", message, false, code, subcode, httpStatus);
  if (code === 100 && httpStatus === 400) return new FacebookGraphError("REMOTE_NOT_FOUND", message, false, code, subcode, httpStatus);
  return new FacebookGraphError("API_ERROR", message, httpStatus >= 500, code, subcode, httpStatus);
}

type FacebookGraphConfig = {
  pageId: string;
  accessToken: string;
  apiVersion: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type FacebookConnectionProbe = {
  pageId: string;
  pageName: string;
  pageTasks: string[];
  grantedPermissions: string[];
};

export type FacebookMetricValue = {
  metricKey: string;
  value: number;
  periodStart: Date | null;
  periodEnd: Date | null;
};

export type FacebookComment = {
  id: string;
  message: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
  permalinkUrl: string | null;
  raw: Record<string, unknown>;
};

export class FacebookGraphAdapter implements SocialPublishAdapter {
  readonly name = "facebook-graph";
  readonly simulated = false;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: FacebookGraphConfig) {
    this.fetchImpl = config.fetchImpl || fetch;
    this.baseUrl = (config.baseUrl || "https://graph.facebook.com").replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs || 30_000;
  }

  async validateConnection(): Promise<FacebookConnectionProbe> {
    const page = await this.request<{ id: string; name?: string; tasks?: string[] }>(
      `${this.config.pageId}?fields=id,name,tasks`,
    );
    if (page.id !== this.config.pageId) throw new FacebookGraphError("TOKEN_INVALID", "令牌返回的 Page 与配置不一致。", false);
    let grantedPermissions: string[] = [];
    try {
      const permissions = await this.request<{ data?: Array<{ permission?: string; status?: string }> }>("me/permissions");
      grantedPermissions = (permissions.data || [])
        .filter((item) => item.status === "granted" && item.permission)
        .map((item) => item.permission!);
    } catch (error) {
      if (!(error instanceof FacebookGraphError) || error.category !== "PERMISSION_DENIED") throw error;
    }
    return { pageId: page.id, pageName: page.name || page.id, pageTasks: page.tasks || [], grantedPermissions };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.platform !== "facebook") return { status: "failed", code: "UNSUPPORTED_PLATFORM", message: "Facebook 适配器只接受 facebook 内容。", retryable: false };
    if (request.accountExternalId !== this.config.pageId) return { status: "failed", code: "PAGE_ID_MISMATCH", message: "任务账号与已验证 Page 不一致。", retryable: false };
    if (request.assets.length > 1) return { status: "failed", code: "FACEBOOK_SINGLE_MEDIA_ONLY", message: "第二阶段真实发布只支持单张图片或单个视频。", retryable: false };
    try {
      let created: { id?: string; post_id?: string };
      if (request.assets.length === 0) {
        const body = new URLSearchParams({ message: request.text });
        created = await this.request(`${this.config.pageId}/feed`, { method: "POST", body });
      } else {
        const asset = request.assets[0];
        if (!["image/png", "image/jpeg", "video/mp4", "video/quicktime"].includes(asset.mimeType)) {
          return { status: "failed", code: "MEDIA_INVALID", message: "Facebook LIVE 仅接受已验证的 PNG、JPEG、MP4 或 QuickTime 单文件素材。", retryable: false };
        }
        const bytes = await readFile(resolveLocalAssetPath(asset.storageKey));
        const form = new FormData();
        form.set("source", new Blob([bytes], { type: asset.mimeType }), asset.originalName || basename(asset.storageKey));
        const isVideo = asset.mimeType.startsWith("video/");
        form.set(isVideo ? "description" : "caption", request.text);
        created = await this.request(`${this.config.pageId}/${isVideo ? "videos" : "photos"}`, { method: "POST", body: form });
      }
      const remotePostId = created.post_id || created.id;
      if (!remotePostId) return { status: "unknown", code: "REMOTE_RESULT_UNKNOWN", message: "Facebook 返回成功响应但没有远端帖子 ID。" };
      const queried = await this.queryByRemotePostId(remotePostId);
      if (queried.status === "published") return queried;
      return { status: "unknown", code: queried.code, message: `Facebook 已返回远端 ID，但帖子状态尚未确认：${queried.message}`, remotePostId, remotePostUrl: "remotePostUrl" in queried ? queried.remotePostUrl : null };
    } catch (error) {
      return this.publishFailure(error);
    }
  }

  async queryByRemotePostId(remotePostId: string): Promise<PublishResult> {
    try {
      const post = await this.request<{ id: string; created_time?: string; permalink_url?: string; is_published?: boolean }>(
        `${encodeURIComponent(remotePostId)}?fields=id,created_time,permalink_url,is_published`,
      );
      if (post.is_published === false) return { status: "failed", code: "REMOTE_NOT_PUBLISHED", message: "Facebook 返回帖子未发布。", retryable: false };
      return {
        status: "published",
        remotePostId: post.id,
        remotePostUrl: post.permalink_url || null,
        publishedAt: post.created_time ? new Date(post.created_time) : new Date(),
      };
    } catch (error) {
      if (error instanceof FacebookGraphError) return { status: "failed", code: error.category, message: this.safeMessage(error.message), retryable: error.retryable };
      return { status: "unknown", code: "REMOTE_RESULT_UNKNOWN", message: "查询 Facebook 远端状态时发生未知错误。" };
    }
  }

  async readMetrics(metricKeys: string[]): Promise<FacebookMetricValue[]> {
    if (!metricKeys.length) return [];
    const response = await this.request<{ data?: Array<{ name?: string; period?: string; values?: Array<{ value?: unknown; end_time?: string }> }> }>(
      `${this.config.pageId}/insights?metric=${encodeURIComponent(metricKeys.join(","))}&period=day`,
    );
    const values: FacebookMetricValue[] = [];
    for (const metric of response.data || []) {
      const latest = metric.values?.at(-1);
      if (!metric.name || typeof latest?.value !== "number") continue;
      const periodEnd = latest.end_time ? new Date(latest.end_time) : null;
      values.push({ metricKey: metric.name, value: latest.value, periodStart: null, periodEnd });
    }
    return values;
  }

  async readComments(remotePostId: string, after?: string | null): Promise<{ comments: FacebookComment[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ fields: "id,message,from,created_time,permalink_url", filter: "stream", limit: "100" });
    if (after) params.set("after", after);
    const response = await this.request<{
      data?: Array<Record<string, unknown> & { id?: string; message?: string; from?: { id?: string; name?: string }; created_time?: string; permalink_url?: string }>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${encodeURIComponent(remotePostId)}/comments?${params}`);
    const comments = (response.data || []).filter((item) => item.id && item.created_time).map((item) => ({
      id: item.id!,
      message: item.message || "",
      authorId: item.from?.id || null,
      authorName: item.from?.name || null,
      createdAt: new Date(item.created_time!),
      permalinkUrl: item.permalink_url || null,
      raw: item,
    }));
    return { comments, nextCursor: response.paging?.next ? response.paging.cursors?.after || null : null };
  }

  async readPostMetrics(remotePostId: string): Promise<Array<{ metricKey: "post_comments_total" | "post_reactions_total"; value: number }>> {
    const response = await this.request<{
      comments?: { summary?: { total_count?: number } };
      reactions?: { summary?: { total_count?: number } };
    }>(`${encodeURIComponent(remotePostId)}?fields=comments.limit(0).summary(true),reactions.limit(0).summary(true)`);
    const values: Array<{ metricKey: "post_comments_total" | "post_reactions_total"; value: number }> = [];
    if (typeof response.comments?.summary?.total_count === "number") values.push({ metricKey: "post_comments_total", value: response.comments.summary.total_count });
    if (typeof response.reactions?.summary?.total_count === "number") values.push({ metricKey: "post_reactions_total", value: response.reactions.summary.total_count });
    return values;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.accessToken}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${this.config.apiVersion}/${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new FacebookGraphError("NETWORK_TIMEOUT", "Facebook 请求超时，远端结果可能未知。", false);
      }
      throw new FacebookGraphError("REMOTE_RESULT_UNKNOWN", "Facebook 网络请求中断，无法确认远端结果。", false);
    }
    const body = await response.json().catch(() => ({})) as GraphErrorBody & T;
    if (!response.ok || body.error) throw classifyFacebookError(body, response.status);
    return body;
  }

  private publishFailure(error: unknown): PublishResult {
    if (error instanceof FacebookGraphError) {
      if (error.category === "NETWORK_TIMEOUT" || error.category === "REMOTE_RESULT_UNKNOWN" || (error.category === "API_ERROR" && error.retryable)) {
        return { status: "unknown", code: error.category === "API_ERROR" ? "REMOTE_RESULT_UNKNOWN" : error.category, message: this.safeMessage(error.message) };
      }
      return { status: "failed", code: error.category, message: this.safeMessage(error.message), retryable: error.retryable };
    }
    return { status: "unknown", code: "REMOTE_RESULT_UNKNOWN", message: "Facebook 发布调用出现未知异常。" };
  }

  private safeMessage(message: string) {
    return message.replaceAll(this.config.accessToken, "[REDACTED]");
  }
}
