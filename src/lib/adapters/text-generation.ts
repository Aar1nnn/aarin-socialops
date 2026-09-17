import { generatedDraftsSchema } from "../contracts";
import { AppError } from "../errors";
import type {
  DraftGenerationInput,
  DraftGenerationResult,
  TextGenerationAdapter,
} from "./types";

const platformStyle = {
  facebook: "business-friendly post with a clear wholesale enquiry call-to-action",
  instagram: "visual-first caption with concise hashtags",
  tiktok: "short video caption and on-screen hook",
  linkedin: "professional B2B product and supply post",
} as const;

export class MockTextGenerationAdapter implements TextGenerationAdapter {
  async generate(input: DraftGenerationInput): Promise<DraftGenerationResult> {
    const factText = input.confirmedFacts.length
      ? input.confirmedFacts.map((fact) => `${fact.key}: ${fact.value}`).join("; ")
      : "No product specifications have been confirmed yet";
    const marketText = input.targetMarkets.length
      ? `For buyers in ${input.targetMarkets.join(", ")}`
      : "For distributors and wholesale buyers (general-market draft; target country pending)";

    const drafts = input.platforms.map((platform) => ({
      platform,
      title: `${input.productName} — ${input.theme}`,
      text: `[SIMULATED GENERATION] ${marketText}. ${input.productName}. Confirmed information: ${factText}. ` +
        `Format: ${platformStyle[platform]}. Please request verified specifications and supply details before quoting.`,
      usedFactKeys: input.confirmedFacts.map((fact) => fact.key),
      missingInformation: input.missingFields,
      isGenericMarketDraft: input.targetMarkets.length === 0,
    }));

    const output = generatedDraftsSchema.parse({ drafts });
    return {
      output,
      provider: "mock",
      model: null,
      simulated: true,
      usage: { inputUnits: 0, outputUnits: 0 },
    };
  }
}

export class OpenAICompatibleTextAdapter implements TextGenerationAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(input: DraftGenerationInput): Promise<DraftGenerationResult> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `${input.instruction}\nReturn JSON matching {drafts:[{platform,title,text,usedFactKeys,missingInformation,isGenericMarketDraft}]}.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              clientName: input.clientName,
              targetMarkets: input.targetMarkets,
              productFocus: input.productFocus,
              brandGuidelines: input.brandGuidelines,
              productName: input.productName,
              objective: input.objective,
              theme: input.theme,
              confirmedFacts: input.confirmedFacts,
              missingFields: input.missingFields,
              platforms: input.platforms,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new AppError(`文本模型调用失败：HTTP ${response.status}`, 502, "MODEL_CALL_FAILED");
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AppError("文本模型未返回内容。", 502, "MODEL_EMPTY_OUTPUT");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError("文本模型输出不是有效 JSON。", 502, "MODEL_INVALID_OUTPUT");
    }
    const output = generatedDraftsSchema.parse(parsed);
    return {
      output,
      provider: "openai-compatible",
      model: this.model,
      simulated: false,
      usage: {
        inputUnits: payload.usage?.prompt_tokens ?? 0,
        outputUnits: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export function getTextGenerationAdapter(provider: string): TextGenerationAdapter {
  if (provider !== "openai-compatible") return new MockTextGenerationAdapter();
  const baseUrl = process.env.TEXT_MODEL_BASE_URL;
  const apiKey = process.env.TEXT_MODEL_API_KEY;
  const model = process.env.TEXT_MODEL_NAME;
  if (baseUrl && apiKey && model) return new OpenAICompatibleTextAdapter(baseUrl, apiKey, model);
  throw new AppError("当前客户已选择真实文本模型，但服务端凭据尚未配置。", 409, "MODEL_CREDENTIALS_MISSING");
}
