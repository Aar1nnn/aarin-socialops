/**
 * Instagram publishing flow adapted from social-media-poster
 * commit 33f00657e5babcc27455758aef4b8b2b97d1eba9 (MIT).
 *
 * Aarin-specific changes: encrypted credential ownership stays outside this
 * adapter, media resolves through StorageAdapter, and mutating requests are
 * never automatically retried so POST_DISPATCH uncertainty remains UNKNOWN.
 */
import { resolveStorageExternalRead, type ExternalReadAssessment } from "./storage";
import type { PublishRequest, PublishResult, SocialPublishAdapter } from "./types";
import { normalizeMetaGraphFailure, PlatformHttpError } from "../platforms/errors";
import { requestPlatformJson } from "../platforms/http-client";
import { redactSensitiveText } from "../token-vault";

type InstagramGraphConfig = {
  igUserId: string;
  accessToken: string;
  apiVersion: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  resolveExternalRead?: (asset: PublishRequest["assets"][number]) => Promise<ExternalReadAssessment>;
};

type GraphIdResponse = { id?: string; error?: unknown };
type GraphStatusResponse = { id?: string; status_code?: string; error?: unknown };
type GraphMediaResponse = {
  id?: string;
  permalink?: string;
  timestamp?: string;
  media_type?: string;
  error?: unknown;
};

type ResolvedMedia = {
  url: string;
  mimeType: string;
  kind: "image" | "video";
};

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime"]);

export class InstagramGraphAdapter implements SocialPublishAdapter {
  readonly name = "meta-instagram";
  readonly simulated = false;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollMaxAttempts: number;

  constructor(private readonly config: InstagramGraphConfig) {
    this.baseUrl = (config.baseUrl || "https://graph.facebook.com").replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs || 30_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 3_000;
    this.pollMaxAttempts = config.pollMaxAttempts ?? 120;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const validation = this.validateRequest(request);
    if (validation) return validation;

    let media: ResolvedMedia[];
    try {
      media = await Promise.all(request.assets.map((asset) => this.resolveMedia(asset)));
    } catch (error) {
      return {
        status: "failed",
        code: "MEDIA_URL_UNAVAILABLE",
        message: safeMessage(error),
        retryable: false,
        failurePhase: "PRE_DISPATCH",
      };
    }

    try {
      const mediaId = media.length === 1
        ? await this.publishSingle(media[0], request.text)
        : await this.publishCarousel(media, request.text);
      const confirmed = await this.queryByRemotePostId(mediaId);
      if (confirmed.status === "published") return confirmed;
      return {
        status: "unknown",
        code: confirmed.code,
        message: `Instagram 已返回远端媒体 ID，但状态尚未确认：${confirmed.message}`,
        remotePostId: mediaId,
        remotePostUrl: "remotePostUrl" in confirmed ? confirmed.remotePostUrl : null,
      };
    } catch (error) {
      return this.publishFailure(error);
    }
  }

  async queryByRemotePostId(remotePostId: string): Promise<PublishResult> {
    try {
      const response = await this.graph<GraphMediaResponse>(
        `${encodeURIComponent(remotePostId)}?fields=id,permalink,timestamp,media_type`,
        { method: "GET" },
        "POST_DISPATCH",
        "SAFE_READS",
      );
      if (!response.id) {
        return {
          status: "unknown",
          code: "REMOTE_RESULT_UNKNOWN",
          message: "Instagram 状态响应缺少媒体 ID。",
          remotePostId,
        };
      }
      const publishedAt = response.timestamp ? new Date(response.timestamp) : new Date();
      return {
        status: "published",
        remotePostId: response.id,
        remotePostUrl: response.permalink || null,
        publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
      };
    } catch (error) {
      const failure = normalizeMetaGraphFailure(error, "POST_DISPATCH");
      if (failure.code === "REMOTE_NOT_FOUND") {
        return { status: "failed", ...failure };
      }
      return {
        status: "unknown",
        code: failure.code,
        message: failure.message,
        remotePostId,
      };
    }
  }

  private validateRequest(request: PublishRequest): PublishResult | null {
    if (request.platform !== "instagram") {
      return preDispatchFailure("UNSUPPORTED_PLATFORM", "Instagram 适配器只接受 instagram 内容。");
    }
    if (request.accountExternalId !== this.config.igUserId) {
      return preDispatchFailure("ACCOUNT_ID_MISMATCH", "任务账号与已选择的 Instagram Professional 账号不一致。");
    }
    if (request.assets.length < 1 || request.assets.length > 10) {
      return preDispatchFailure("MEDIA_INVALID", "Instagram 发布必须包含 1 到 10 个图片或视频素材。");
    }
    if (request.text.length > 2_200) {
      return preDispatchFailure("CONTENT_VALIDATION_FAILED", "Instagram caption 超过 2200 字符上限。");
    }
    for (const asset of request.assets) {
      if (!SUPPORTED_IMAGE_TYPES.has(asset.mimeType) && !SUPPORTED_VIDEO_TYPES.has(asset.mimeType)) {
        return preDispatchFailure("MEDIA_INVALID", `Instagram 不支持素材类型：${asset.mimeType}`);
      }
    }
    return null;
  }

  private async resolveMedia(asset: PublishRequest["assets"][number]): Promise<ResolvedMedia> {
    const externalRead = this.config.resolveExternalRead
      ? await this.config.resolveExternalRead(asset)
      : await resolveStorageExternalRead(asset, { expiresSeconds: 3_600 });
    if (!externalRead.ready || !externalRead.url) throw new Error(externalRead.message);
    return {
      url: externalRead.url,
      mimeType: asset.mimeType,
      kind: asset.mimeType.startsWith("video/") ? "video" : "image",
    };
  }

  private async publishSingle(media: ResolvedMedia, caption: string) {
    const form = new URLSearchParams();
    if (media.kind === "image") form.set("image_url", media.url);
    else {
      form.set("media_type", "REELS");
      form.set("video_url", media.url);
    }
    if (caption.trim()) form.set("caption", caption);
    const creationId = await this.createContainer(form);
    if (media.kind === "video") await this.waitForContainer(creationId);
    return this.publishContainer(creationId);
  }

  private async publishCarousel(media: ResolvedMedia[], caption: string) {
    const childIds: string[] = [];
    for (const item of media) {
      const form = new URLSearchParams({ is_carousel_item: "true" });
      if (item.kind === "image") form.set("image_url", item.url);
      else {
        form.set("media_type", "VIDEO");
        form.set("video_url", item.url);
      }
      const childId = await this.createContainer(form);
      if (item.kind === "video") await this.waitForContainer(childId);
      childIds.push(childId);
    }
    const parent = new URLSearchParams({ media_type: "CAROUSEL", children: childIds.join(",") });
    if (caption.trim()) parent.set("caption", caption);
    const parentId = await this.createContainer(parent);
    return this.publishContainer(parentId);
  }

  private async createContainer(form: URLSearchParams) {
    const response = await this.graph<GraphIdResponse>(
      `${this.config.igUserId}/media`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      },
      "POST_DISPATCH",
      "NONE",
    );
    if (!response.id) throw new Error("Instagram 创建媒体容器后没有返回 creation id。");
    return response.id;
  }

  private async waitForContainer(creationId: string) {
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt += 1) {
      const response = await this.graph<GraphStatusResponse>(
        `${encodeURIComponent(creationId)}?fields=status_code`,
        { method: "GET" },
        "POST_DISPATCH",
        "SAFE_READS",
      );
      if (response.status_code === "FINISHED" || response.status_code === "PUBLISHED") return;
      if (response.status_code === "ERROR" || response.status_code === "EXPIRED") {
        throw new ExplicitInstagramFailure(
          "MEDIA_INVALID",
          `Instagram 媒体容器进入终止状态：${response.status_code}`,
        );
      }
      await delay(this.pollIntervalMs);
    }
    throw new UncertainInstagramFailure("Instagram 媒体容器处理超时，远端状态未知。");
  }

  private async publishContainer(creationId: string) {
    const response = await this.graph<GraphIdResponse>(
      `${this.config.igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ creation_id: creationId }),
      },
      "POST_DISPATCH",
      "NONE",
    );
    if (!response.id) throw new UncertainInstagramFailure("Instagram 发布响应缺少远端媒体 ID。");
    return response.id;
  }

  private async graph<T>(
    path: string,
    init: RequestInit,
    failurePhase: "PRE_DISPATCH" | "POST_DISPATCH",
    retryMode: "NONE" | "SAFE_READS",
  ) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.accessToken}`);
    const response = await requestPlatformJson<T>(
      `${this.baseUrl}/${this.config.apiVersion}/${path}`,
      {
        ...init,
        headers,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.config.fetchImpl,
        retryMode,
        failurePhase,
      },
    );
    const body = response.body as T & { error?: unknown };
    if (body && typeof body === "object" && body.error) {
      throw new PlatformHttpError(
        "HTTP",
        "Meta Graph API returned an error.",
        failurePhase,
        response.status,
        body,
      );
    }
    return body;
  }

  private publishFailure(error: unknown): PublishResult {
    if (error instanceof ExplicitInstagramFailure) {
      return {
        status: "failed",
        code: error.code,
        message: safeMessage(error),
        retryable: false,
        failurePhase: "POST_DISPATCH",
      };
    }
    if (error instanceof UncertainInstagramFailure) {
      return { status: "unknown", code: "REMOTE_RESULT_UNKNOWN", message: safeMessage(error) };
    }
    const failure = normalizeMetaGraphFailure(error, "POST_DISPATCH");
    if (failure.uncertain) {
      return { status: "unknown", code: failure.code, message: failure.message };
    }
    return { status: "failed", ...failure };
  }
}

class ExplicitInstagramFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExplicitInstagramFailure";
  }
}

class UncertainInstagramFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertainInstagramFailure";
  }
}

function preDispatchFailure(code: string, message: string): PublishResult {
  return { status: "failed", code, message, retryable: false, failurePhase: "PRE_DISPATCH" };
}

function safeMessage(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : "Instagram 发布出现未知错误。");
}

function delay(ms: number) {
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
