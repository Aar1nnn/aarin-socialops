export type PublishFailurePhase = "PRE_DISPATCH" | "POST_DISPATCH";
export type PublishFailureCategory =
  | "AUTH"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "VALIDATION"
  | "CONTENT_REJECTED"
  | "MEDIA"
  | "NETWORK_PRE_DISPATCH"
  | "NETWORK_POST_DISPATCH"
  | "REMOTE_UNKNOWN"
  | "SERVER_PRE_DISPATCH"
  | "SERVER_POST_DISPATCH"
  | "ADAPTER_UNAVAILABLE";

export type RetryDecision = "RETRY" | "FAILED" | "UNKNOWN" | "WAITING_CONFIGURATION";

export function classifyPublishFailure(code: string, phase: PublishFailurePhase): PublishFailureCategory {
  if (code === "TOKEN_INVALID") return "AUTH";
  if (code === "PERMISSION_DENIED") return "PERMISSION";
  if (code === "RATE_LIMITED") return "RATE_LIMIT";
  if (code.includes("VALIDATION") || code.includes("MISMATCH") || code.includes("UNSUPPORTED_PLATFORM")) return "VALIDATION";
  if (code === "CONTENT_REJECTED") return "CONTENT_REJECTED";
  if (code.includes("MEDIA")) return "MEDIA";
  if (code.includes("TIMEOUT") || code.includes("NETWORK")) return phase === "PRE_DISPATCH" ? "NETWORK_PRE_DISPATCH" : "NETWORK_POST_DISPATCH";
  if (code.includes("UNKNOWN")) return "REMOTE_UNKNOWN";
  if (code.includes("ADAPTER") || code.includes("CONNECTION")) return "ADAPTER_UNAVAILABLE";
  return phase === "PRE_DISPATCH" ? "SERVER_PRE_DISPATCH" : "SERVER_POST_DISPATCH";
}

export function decidePublishRetry(input: {
  phase: PublishFailurePhase;
  category: PublishFailureCategory;
  attempt: number;
  maxAttempts: number;
  adapterRetryable?: boolean;
}): RetryDecision {
  if (input.phase === "PRE_DISPATCH" && input.category === "ADAPTER_UNAVAILABLE") return "WAITING_CONFIGURATION";
  if (input.phase === "POST_DISPATCH" && ["NETWORK_POST_DISPATCH", "REMOTE_UNKNOWN", "SERVER_POST_DISPATCH"].includes(input.category)) return "UNKNOWN";
  if (["AUTH", "PERMISSION", "VALIDATION", "CONTENT_REJECTED", "MEDIA"].includes(input.category)) return "FAILED";
  if (input.adapterRetryable === false || input.attempt >= input.maxAttempts) return "FAILED";
  return "RETRY";
}
