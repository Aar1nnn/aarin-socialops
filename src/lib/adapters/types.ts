import type { ClientMode } from "@prisma/client";
import type { GeneratedDrafts } from "../contracts";

export type DraftGenerationInput = {
  clientName: string;
  mode: ClientMode;
  targetMarkets: string[];
  productFocus: string | null;
  brandGuidelines: string | null;
  productName: string;
  objective: string;
  theme: string;
  confirmedFacts: Array<{ key: string; value: string; source: string }>;
  missingFields: string[];
  platforms: Array<"facebook" | "instagram" | "tiktok" | "linkedin">;
  instruction: string;
  brandProfile?: {
    businessSummary: string | null;
    positioning: string | null;
    audience: string | null;
    tone: string | null;
    voiceTraits: string[];
    goals: string[];
    contentLanguages: string[];
    imageStyle: string | null;
    bannedPhrases: string[];
    requiredMentions: string[];
    ctaRules: string[];
  };
  recentContent?: Array<{ platform: string; theme: string; hook: string; cta: string | null; product: string | null }>;
  performanceContext?: Array<{ metricKey: string; platform: string; value: string | null; availability: string; dataKind: string }>;
  researchContext?: Array<{ kind: string; objective: string; observations: unknown; limitations: unknown }>;
  strategy?: {
    audience: string;
    messageAngle: string;
    contentGoal: string;
    differentiation: string[];
  };
};

export type DraftGenerationResult = {
  output: GeneratedDrafts;
  provider: string;
  model: string | null;
  simulated: boolean;
  usage: { inputUnits: number; outputUnits: number };
};

export interface TextGenerationAdapter {
  generate(input: DraftGenerationInput): Promise<DraftGenerationResult>;
}

export type PublishRequest = {
  clientId: string;
  platform: string;
  accountExternalId: string | null;
  text: string;
  assets: Array<{
    storageProvider?: string;
    storageKey: string;
    mimeType: string;
    originalName: string;
  }>;
  idempotencyKey: string;
};

export type PublishResult =
  | { status: "published"; remotePostId: string; remotePostUrl: string | null; publishedAt: Date }
  | { status: "failed"; code: string; message: string; retryable: boolean; failurePhase?: "PRE_DISPATCH" | "POST_DISPATCH" }
  | { status: "unknown"; code: string; message: string; remotePostId?: string; remotePostUrl?: string | null };

export interface SocialPublishAdapter {
  readonly name: string;
  readonly simulated: boolean;
  publish(request: PublishRequest): Promise<PublishResult>;
  queryByRemotePostId?(remotePostId: string): Promise<PublishResult>;
  queryByIdempotencyKey?(idempotencyKey: string): Promise<PublishResult | null>;
}
