import { describe, expect, it } from "vitest";
import { selectDefaultMembership } from "../src/lib/default-client-selection";

function membership(input: {
  id: string;
  slug: string;
  isDemo: boolean;
  createdAt: string;
}) {
  return {
    clientId: input.id,
    role: "OWNER",
    client: {
      id: input.id,
      slug: input.slug,
      isDemo: input.isDemo,
      createdAt: new Date(input.createdAt),
    },
  };
}

describe("default client selection", () => {
  it("always prefers demo-furniture-export over the test fixture regardless of membership order", () => {
    const preferred = membership({ id: "preferred", slug: "demo-furniture-export", isDemo: true, createdAt: "2026-01-02T00:00:00.000Z" });
    const fixture = membership({ id: "fixture", slug: "v2-test-client", isDemo: true, createdAt: "2026-01-01T00:00:00.000Z" });

    expect(selectDefaultMembership([preferred, fixture])?.client.slug).toBe("demo-furniture-export");
    expect(selectDefaultMembership([fixture, preferred])?.client.slug).toBe("demo-furniture-export");
  });

  it("selects the deterministic first demo when the preferred client is absent", () => {
    const demoAlpha = membership({ id: "demo-2", slug: "demo-alpha", isDemo: true, createdAt: "2026-01-01T00:00:00.000Z" });
    const demoZulu = membership({ id: "demo-1", slug: "demo-zulu", isDemo: true, createdAt: "2026-01-01T00:00:00.000Z" });
    const live = membership({ id: "live", slug: "live-client", isDemo: false, createdAt: "2025-01-01T00:00:00.000Z" });

    expect(selectDefaultMembership([demoZulu, live, demoAlpha])?.client.slug).toBe("demo-alpha");
    expect(selectDefaultMembership([demoAlpha, live, demoZulu])?.client.slug).toBe("demo-alpha");
  });

  it("uses a deterministic fallback when no demo client exists", () => {
    const earlier = membership({ id: "client-b", slug: "client-zulu", isDemo: false, createdAt: "2026-01-01T00:00:00.000Z" });
    const later = membership({ id: "client-a", slug: "client-alpha", isDemo: false, createdAt: "2026-02-01T00:00:00.000Z" });

    expect(selectDefaultMembership([later, earlier])?.client.id).toBe("client-b");
    expect(selectDefaultMembership([earlier, later])?.client.id).toBe("client-b");
  });
});
