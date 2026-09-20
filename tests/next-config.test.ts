import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "../next.config";

describe("Content Security Policy", () => {
  it("allows React development diagnostics without weakening production", () => {
    const development = buildContentSecurityPolicy("development");
    const production = buildContentSecurityPolicy("production");

    expect(development).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(production).toContain("script-src 'self' 'unsafe-inline'");
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).toContain("connect-src 'self'");
    expect(development).not.toMatch(/(?:default|script|connect|img|frame)-src\s+\*/);
    expect(production).not.toMatch(/(?:default|script|connect|img|frame)-src\s+\*/);
  });
});
