import { describe, expect, it } from "vitest";
import { decidePublishRetry } from "../src/lib/publish-safety";

describe("publish retry safety", () => {
  it("never retries a post-dispatch timeout", () => {
    expect(decidePublishRetry({ phase: "POST_DISPATCH", category: "NETWORK_POST_DISPATCH", attempt: 1, maxAttempts: 3 })).toBe("UNKNOWN");
  });

  it("allows bounded retries for an explicit rate limit", () => {
    expect(decidePublishRetry({ phase: "POST_DISPATCH", category: "RATE_LIMIT", attempt: 1, maxAttempts: 3 })).toBe("RETRY");
    expect(decidePublishRetry({ phase: "POST_DISPATCH", category: "RATE_LIMIT", attempt: 3, maxAttempts: 3 })).toBe("FAILED");
  });

  it("routes missing adapters to configuration instead of simulation", () => {
    expect(decidePublishRetry({ phase: "PRE_DISPATCH", category: "ADAPTER_UNAVAILABLE", attempt: 0, maxAttempts: 3 })).toBe("WAITING_CONFIGURATION");
  });
});
