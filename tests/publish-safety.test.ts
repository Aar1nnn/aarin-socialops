import { describe, expect, it } from "vitest";
import { decidePublishRetry } from "../src/lib/publish-safety";

describe("publish retry safety", () => {
  it("never retries a post-dispatch timeout", () => {
    expect(decidePublishRetry({ phase: "POST_DISPATCH", category: "NETWORK_POST_DISPATCH", attempt: 1, maxAttempts: 3 })).toBe("UNKNOWN");
  });

  it("fails a post-dispatch rate limit instead of retrying", () => {
    expect(decidePublishRetry({ phase: "POST_DISPATCH", category: "RATE_LIMIT", attempt: 1, maxAttempts: 3, adapterRetryable: true })).toBe("FAILED");
  });

  it("allows a bounded retry only for an explicitly retryable pre-dispatch rate limit", () => {
    expect(decidePublishRetry({ phase: "PRE_DISPATCH", category: "RATE_LIMIT", attempt: 1, maxAttempts: 3, adapterRetryable: true })).toBe("RETRY");
    expect(decidePublishRetry({ phase: "PRE_DISPATCH", category: "RATE_LIMIT", attempt: 3, maxAttempts: 3, adapterRetryable: true })).toBe("FAILED");
  });

  it("routes missing adapters to configuration instead of simulation", () => {
    expect(decidePublishRetry({ phase: "PRE_DISPATCH", category: "ADAPTER_UNAVAILABLE", attempt: 0, maxAttempts: 3 })).toBe("WAITING_CONFIGURATION");
  });

  it("retries only an explicitly pre-dispatch server failure within the cap", () => {
    expect(decidePublishRetry({ phase: "PRE_DISPATCH", category: "SERVER_PRE_DISPATCH", attempt: 1, maxAttempts: 3, adapterRetryable: true })).toBe("RETRY");
    expect(decidePublishRetry({ phase: "PRE_DISPATCH", category: "SERVER_PRE_DISPATCH", attempt: 3, maxAttempts: 3, adapterRetryable: true })).toBe("FAILED");
  });

  it("marks a post-dispatch server failure as unknown", () => {
    expect(decidePublishRetry({ phase: "POST_DISPATCH", category: "SERVER_POST_DISPATCH", attempt: 1, maxAttempts: 3, adapterRetryable: true })).toBe("UNKNOWN");
  });

  it("defaults a missing failure phase to post-dispatch and never retries it", () => {
    expect(decidePublishRetry({ category: "RATE_LIMIT", attempt: 1, maxAttempts: 3, adapterRetryable: true })).toBe("FAILED");
  });
});
