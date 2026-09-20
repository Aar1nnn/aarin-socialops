export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "BAD_REQUEST",
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error("Unhandled application error", redactLogMessage(error instanceof Error ? error.message : "unknown"));
  return Response.json(
    { error: "INTERNAL_ERROR", message: "服务器处理失败，请查看服务日志。" },
    { status: 500 },
  );
}

function redactLogMessage(message: string) {
  return message
    .replace(/\bEAA[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:code|access_token|refresh_token|client_secret)=)[^&\s]+/gi, "$1[REDACTED]");
}
