import type { PublishFailurePhase } from "../publish-safety";
import { PlatformHttpError } from "./errors";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

export type RateLimitInfo = {
  remaining?: number;
  resetAt?: Date;
};

export type PlatformJsonRequest = RequestInit & {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryMode?: "NONE" | "SAFE_READS";
  maxAttempts?: number;
  baseDelayMs?: number;
  failurePhase?: PublishFailurePhase;
};

export type PlatformJsonResponse<T> = {
  body: T;
  status: number;
  headers: Headers;
  rateLimit: RateLimitInfo;
};

export async function requestPlatformJson<T>(
  input: string | URL,
  init: PlatformJsonRequest = {},
): Promise<PlatformJsonResponse<T>> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryMode = "NONE",
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    failurePhase = "PRE_DISPATCH",
    fetchImpl = fetch,
    signal: callerSignal,
    ...requestInit
  } = init;
  const method = (requestInit.method || "GET").toUpperCase();
  const safeRead = method === "GET" || method === "HEAD";
  if (retryMode === "SAFE_READS" && !safeRead) {
    throw new PlatformHttpError(
      "ABORTED",
      `Automatic retry is forbidden for mutating ${method} platform requests.`,
      "PRE_DISPATCH",
    );
  }
  const attempts = retryMode === "SAFE_READS" && safeRead ? Math.max(1, maxAttempts) : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = mergeAbortSignals([timeoutController.signal, callerSignal].filter(Boolean) as AbortSignal[]);
    try {
      const response = await fetchImpl(input, { ...requestInit, signal });
      const text = await response.text();
      const body = parseJson(text, failurePhase, response.status);
      if (response.ok) {
        return {
          body: body as T,
          status: response.status,
          headers: response.headers,
          rateLimit: parseRateLimitHeaders(response.headers),
        };
      }
      if (attempt < attempts && isRetryableReadStatus(response.status)) {
        await delay(retryDelayMs(response.headers, attempt, baseDelayMs));
        continue;
      }
      throw new PlatformHttpError(
        "HTTP",
        `Platform API returned HTTP ${response.status}.`,
        failurePhase,
        response.status,
        body,
      );
    } catch (error) {
      if (error instanceof PlatformHttpError) throw error;
      if (callerSignal?.aborted) {
        throw new PlatformHttpError("ABORTED", "Platform request was aborted.", failurePhase);
      }
      const timedOut = timeoutController.signal.aborted
        || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
      if (attempt < attempts) {
        await delay(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw new PlatformHttpError(
        timedOut ? "TIMEOUT" : "NETWORK",
        timedOut ? "Platform request timed out." : "Platform network request failed.",
        failurePhase,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new PlatformHttpError("NETWORK", "Platform request failed.", failurePhase);
}

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const remainingRaw = headers.get("x-rate-limit-remaining") ?? headers.get("x-ratelimit-remaining");
  const resetRaw = headers.get("x-rate-limit-reset") ?? headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
  const retryAfterRaw = headers.get("retry-after");
  const remaining = parseInteger(remainingRaw);
  let resetAt: Date | undefined;
  const resetValue = parseInteger(resetRaw);
  if (resetValue !== undefined) resetAt = new Date(resetValue < 1e12 ? resetValue * 1_000 : resetValue);
  if (!resetAt && retryAfterRaw) {
    const seconds = parseInteger(retryAfterRaw);
    if (seconds !== undefined) resetAt = new Date(Date.now() + seconds * 1_000);
    else {
      const date = Date.parse(retryAfterRaw);
      if (!Number.isNaN(date)) resetAt = new Date(date);
    }
  }
  return { remaining, resetAt };
}

function parseJson(text: string, failurePhase: PublishFailurePhase, status: number): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PlatformHttpError(
      "INVALID_RESPONSE",
      `Platform API returned invalid JSON with HTTP ${status}.`,
      failurePhase,
      status,
    );
  }
}

function isRetryableReadStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(headers: Headers, attempt: number, baseDelayMs: number) {
  const resetAt = parseRateLimitHeaders(headers).resetAt;
  return resetAt ? Math.max(0, resetAt.getTime() - Date.now()) : baseDelayMs * 2 ** (attempt - 1);
}

function parseInteger(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function mergeAbortSignals(signals: AbortSignal[]) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 30_000)));
}
