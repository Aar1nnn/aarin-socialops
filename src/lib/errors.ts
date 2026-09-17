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
  console.error("Unhandled application error", error instanceof Error ? error.message : "unknown");
  return Response.json(
    { error: "INTERNAL_ERROR", message: "服务器处理失败，请查看服务日志。" },
    { status: 500 },
  );
}
