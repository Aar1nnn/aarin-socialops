import { sha256 } from "../security";
import type { PublishRequest, PublishResult, SocialPublishAdapter } from "./types";

export class MockSocialPublishAdapter implements SocialPublishAdapter {
  readonly name = "mock-social";
  readonly simulated = true;

  constructor(private readonly forcedOutcome?: "published" | "failed" | "unknown") {}

  async publish(request: PublishRequest): Promise<PublishResult> {
    const outcome = this.forcedOutcome ?? "published";
    if (outcome === "unknown") {
      return { status: "unknown", code: "MOCK_TIMEOUT", message: "模拟请求超时，远端结果未知。" };
    }
    if (outcome === "failed") {
      return { status: "failed", code: "MOCK_FAILURE", message: "模拟发送前可重试失败。", retryable: true, failurePhase: "PRE_DISPATCH" };
    }
    const remotePostId = `mock_${sha256(request.idempotencyKey).slice(0, 16)}`;
    return {
      status: "published",
      remotePostId,
      remotePostUrl: `mock://post/${request.platform}/${remotePostId}`,
      publishedAt: new Date(),
    };
  }

  async queryByIdempotencyKey(idempotencyKey: string): Promise<PublishResult | null> {
    const remotePostId = `mock_${sha256(idempotencyKey).slice(0, 16)}`;
    return {
      status: "published",
      remotePostId,
      remotePostUrl: `mock://post/reconciled/${remotePostId}`,
      publishedAt: new Date(),
    };
  }
}
