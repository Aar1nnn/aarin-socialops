import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLISHING_LANES, publishingStatusLabel, safeRemotePostUrl } from "../src/lib/presentation/publishing";

function source(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("UI V2 Phase 1 route contracts", () => {
  it("keeps the legacy connections route and action targets available", () => {
    const page = source("../src/app/connections/page.tsx");
    expect(page).toContain('action="/api/connections/meta/start"');
    expect(page).toContain('name="returnTo" value="/connections"');
    expect(page).toContain("/select-accounts`}");
    expect(page).toContain("/disconnect`}");
  });

  it("keeps Meta OAuth and form-action return paths compatible", () => {
    const start = source("../src/app/api/connections/meta/start/route.ts");
    const callback = source("../src/app/api/connections/meta/callback/route.ts");
    const selection = source("../src/app/api/connections/[id]/select-accounts/route.ts");
    expect(start).toContain('body.returnTo || "/connections"');
    expect(callback).toContain("new URL(result.returnTo, request.url)");
    expect(selection).toContain('"/connections"');
  });

  it("provides an account-first canonical route without removing the alias", () => {
    const canonicalPath = fileURLToPath(new URL("../src/app/accounts/page.tsx", import.meta.url));
    expect(existsSync(canonicalPath)).toBe(true);
    expect(source("../src/app/accounts/page.tsx")).toContain('from "../connections/page"');
  });

  it("keeps canonical navigation grouped and the alias active", () => {
    const nav = source("../src/components/primary-nav.tsx");
    for (const label of ["工作台", "运营", "资产", "互动与分析", "系统"]) {
      expect(nav).toContain(`label: "${label}"`);
    }
    expect(nav).toContain('pathname.startsWith("/connections")');
    expect(nav).toContain('<span className="nav-group-label">{group.label}</span>');
  });

  it("keeps Quick Create role-aware and workspace switching on its existing action", () => {
    const shell = source("../src/components/operator-shell.tsx");
    expect(shell).toContain('context.role !== "VIEWER"');
    expect(shell).toContain('/content?create=1#new-content');
    expect(shell).toContain('/products?create=1#create-product');
    expect(shell).toContain('action="/api/auth/switch-client"');
    expect(shell).toContain('where: { clientId: context.clientId, readAt: null }');
  });

  it("keeps the publishing projection tenant-scoped and read-only", () => {
    const page = source("../src/app/publishing/page.tsx");
    expect(page.match(/where: \{ clientId: context\.clientId \}/g)).toHaveLength(2);
    expect(page).toContain('title="发布中心"');
    expect(page).toContain('UNKNOWN 表示远端结果尚未确认，不能盲目重发');
    expect(page).not.toContain('<form');
    expect(page).not.toContain('重试</');
  });

  it("does not collapse UNKNOWN into failed or link to untrusted remote schemes", () => {
    expect(PUBLISHING_LANES.find((lane) => lane.key === "unknown")?.statuses).toEqual(["UNKNOWN"]);
    expect(PUBLISHING_LANES.find((lane) => lane.key === "failed")?.statuses).toEqual(["FAILED"]);
    expect(publishingStatusLabel("PENDING")).toBe("排队中");
    expect(safeRemotePostUrl("https://example.test/post/1")).toBe("https://example.test/post/1");
    expect(safeRemotePostUrl("javascript:alert(1)")).toBeNull();
    expect(safeRemotePostUrl("http://example.test/post/1")).toBeNull();
  });
});
