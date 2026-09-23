import type { PublishFailurePhase } from "../publish-safety";
import { redactSensitiveText } from "../token-vault";

export type PlatformHttpErrorKind = "TIMEOUT" | "NETWORK" | "HTTP" | "INVALID_RESPONSE" | "ABORTED";

export class PlatformHttpError extends Error {
  constructor(
    readonly kind: PlatformHttpErrorKind,
    message: string,
    readonly failurePhase: PublishFailurePhase,
    readonly status?: number,
    readonly responseBody?: unknown,
  ) {
    super(redactSensitiveText(message));
    this.name = "PlatformHttpError";
  }
}

export type MetaGraphErrorBody = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
};

export type NormalizedPlatformFailure = {
  code: string;
  message: string;
  retryable: boolean;
  failurePhase: PublishFailurePhase;
  uncertain: boolean;
};

export function normalizeMetaGraphFailure(
  error: unknown,
  fallbackPhase: PublishFailurePhase,
): NormalizedPlatformFailure {
  if (!(error instanceof PlatformHttpError)) {
    return {
      code: fallbackPhase === "POST_DISPATCH" ? "REMOTE_RESULT_UNKNOWN" : "PLATFORM_REQUEST_FAILED",
      message: redactSensitiveText(error instanceof Error ? error.message : "Platform request failed."),
      retryable: fallbackPhase === "PRE_DISPATCH",
      failurePhase: fallbackPhase,
      uncertain: fallbackPhase === "POST_DISPATCH",
    };
  }

  const phase = error.failurePhase;
  const graphError = readMetaGraphError(error.responseBody);
  const message = redactSensitiveText(
    graphError?.error_user_msg || graphError?.message || error.message,
  );
  const code = graphError?.code;
  const subcode = graphError?.error_subcode;

  if (code === 190 || code === 102 || subcode === 460 || subcode === 463 || subcode === 467) {
    return knownFailure("TOKEN_INVALID", message, phase);
  }
  if (code === 10 || code === 200 || code === 299) {
    return knownFailure("PERMISSION_DENIED", message, phase);
  }
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    code === 80004 ||
    code === 80007 ||
    error.status === 429
  ) {
    return knownFailure("RATE_LIMITED", message, phase);
  }
  if (code === 368 || code === 506) {
    return knownFailure("CONTENT_REJECTED", message, phase);
  }
  if (code === 324 || code === 352 || code === 360 || code === 361) {
    return knownFailure("MEDIA_INVALID", message, phase);
  }
  if (code === 100 && (error.status === 400 || error.status === 404)) {
    return knownFailure("REMOTE_NOT_FOUND", message, phase);
  }

  if (
    phase === "POST_DISPATCH" &&
    (error.kind === "TIMEOUT" || error.kind === "NETWORK" || (error.status !== undefined && error.status >= 500))
  ) {
    return {
      code: error.kind === "TIMEOUT" ? "NETWORK_TIMEOUT" : "REMOTE_RESULT_UNKNOWN",
      message,
      retryable: false,
      failurePhase: phase,
      uncertain: true,
    };
  }

  return {
    code: error.kind === "TIMEOUT" ? "NETWORK_TIMEOUT" : "PLATFORM_API_ERROR",
    message,
    retryable: phase === "PRE_DISPATCH" && (error.kind === "TIMEOUT" || error.kind === "NETWORK"),
    failurePhase: phase,
    uncertain: false,
  };
}

function knownFailure(
  code: string,
  message: string,
  failurePhase: PublishFailurePhase,
): NormalizedPlatformFailure {
  return { code, message, retryable: false, failurePhase, uncertain: false };
}

function readMetaGraphError(body: unknown): MetaGraphErrorBody | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as { error?: unknown };
  if (!envelope.error || typeof envelope.error !== "object") return null;
  return envelope.error as MetaGraphErrorBody;
}
