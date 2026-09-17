import { describe, expect, it } from "vitest";
import { MockTextGenerationAdapter } from "../src/lib/adapters/text-generation";
import { classifyIntent } from "../src/services/interaction-service";

describe("intent classification", () => {
  it("does not turn likes, emoji or generic praise into leads", () => {
    for (const text of ["👍", "Nice!", "好看", "❤️"]) {
      expect(classifyIntent(text).isLead).toBe(false);
    }
  });

  it("preserves a clear wholesale intent classification", () => {
    const result = classifyIntent("We are a distributor. Please send your wholesale catalog and MOQ.");
    expect(result.isLead).toBe(true);
    expect(["WHOLESALE", "CATALOG_REQUEST", "PROCUREMENT"]).toContain(result.category);
  });
});

describe("mock generation", () => {
  it("uses confirmed facts only and labels unknown market and simulation", async () => {
    const result = await new MockTextGenerationAdapter().generate({
      clientName: "Test",
      mode: "DEMO",
      targetMarkets: [],
      productFocus: null,
      brandGuidelines: null,
      productName: "Chair",
      objective: "B2B enquiry",
      theme: "Product intro",
      confirmedFacts: [{ key: "material", value: "steel", source: "customer sheet" }],
      missingFields: ["dimensions", "secret-proposed-field"],
      platforms: ["facebook"],
      instruction: "Only confirmed facts",
    });
    expect(result.simulated).toBe(true);
    expect(result.output.drafts[0].text).toContain("[SIMULATED GENERATION]");
    expect(result.output.drafts[0].text).toContain("steel");
    expect(result.output.drafts[0].text).not.toContain("secret-proposed-field");
    expect(result.output.drafts[0].isGenericMarketDraft).toBe(true);
  });
});
