import { describe, expect, it } from "vitest";
import type { DraftGenerationInput, TextGenerationAdapter } from "../src/lib/adapters/types";
import { runPreparedAIContentPipeline } from "../src/services/ai-content-pipeline-service";

const input: DraftGenerationInput = {
  clientName: "Safety test",
  mode: "DRAFT",
  targetMarkets: [],
  productFocus: null,
  brandGuidelines: null,
  productName: "Chair",
  objective: "Leads",
  theme: "Wholesale",
  confirmedFacts: [{ key: "material", value: "steel", source: "customer sheet" }],
  missingFields: ["size"],
  platforms: ["facebook"],
  instruction: "Use confirmed facts only",
  strategy: { audience: "Distributors", messageAngle: "Durability", contentGoal: "Leads", differentiation: ["steel"] },
};

describe("AI content pipeline safety", () => {
  it("hard-rejects generated drafts that claim unconfirmed fact keys", async () => {
    const adapter: TextGenerationAdapter = { async generate() {
      return {
        provider: "unsafe",
        model: "test",
        simulated: true,
        usage: { inputUnits: 1, outputUnits: 1 },
        output: { drafts: [{ platform: "facebook", title: "Unsafe", text: "Unverified size claim.", usedFactKeys: ["size"], missingInformation: [], isGenericMarketDraft: false }] },
      };
    } };
    await expect(runPreparedAIContentPipeline(input, adapter)).rejects.toMatchObject({ code: "AI_UNCONFIRMED_FACT_USED" });
  });
});
