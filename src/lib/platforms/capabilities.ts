import type { Provider } from "@prisma/client";

export type PlatformCapability =
  | "AUTH"
  | "PUBLISH"
  | "STATUS_QUERY"
  | "PROFILE"
  | "METRICS"
  | "COMMENTS";

export type PlatformMediaKind = "IMAGE" | "VIDEO";

export type PlatformMediaRules = {
  required: boolean;
  minItems: number;
  maxItems: number;
  kinds: readonly PlatformMediaKind[];
  requiresPublicHttpsUrl: boolean;
};

export type PlatformContentRules = {
  supportsTextOnly: boolean;
  maxTextLength: number | null;
};

export type PlatformDefinition = {
  provider: Provider;
  platform: string;
  accountTypes: readonly string[];
  capabilities: readonly PlatformCapability[];
  defaultPublishAdapter: string | null;
  supportedPublishAdapters: readonly string[];
  media: PlatformMediaRules;
  content: PlatformContentRules;
  externalVerification: "VERIFIED" | "IMPLEMENTED_NOT_EXTERNALLY_VERIFIED" | "NOT_IMPLEMENTED";
};

export const FACEBOOK_PLATFORM_DEFINITION: PlatformDefinition = {
  provider: "META",
  platform: "facebook",
  accountTypes: ["FACEBOOK_PAGE"],
  capabilities: ["AUTH", "PUBLISH", "STATUS_QUERY", "PROFILE", "METRICS", "COMMENTS"],
  defaultPublishAdapter: "meta-facebook",
  supportedPublishAdapters: ["meta-facebook", "facebook-graph"],
  media: {
    required: false,
    minItems: 0,
    maxItems: 1,
    kinds: ["IMAGE", "VIDEO"],
    requiresPublicHttpsUrl: false,
  },
  content: { supportsTextOnly: true, maxTextLength: null },
  externalVerification: "VERIFIED",
};

export const INSTAGRAM_PLATFORM_DEFINITION: PlatformDefinition = {
  provider: "META",
  platform: "instagram",
  accountTypes: ["INSTAGRAM_PROFESSIONAL"],
  capabilities: ["AUTH", "PUBLISH", "STATUS_QUERY", "PROFILE"],
  defaultPublishAdapter: "meta-instagram",
  supportedPublishAdapters: ["meta-instagram"],
  media: {
    required: true,
    minItems: 1,
    maxItems: 10,
    kinds: ["IMAGE", "VIDEO"],
    requiresPublicHttpsUrl: true,
  },
  content: { supportsTextOnly: false, maxTextLength: 2_200 },
  externalVerification: "IMPLEMENTED_NOT_EXTERNALLY_VERIFIED",
};

export const LINKEDIN_PLATFORM_DEFINITION: PlatformDefinition = {
  provider: "LINKEDIN",
  platform: "linkedin",
  accountTypes: ["LINKEDIN_MEMBER", "LINKEDIN_ORGANIZATION"],
  capabilities: [],
  defaultPublishAdapter: null,
  supportedPublishAdapters: [],
  media: { required: false, minItems: 0, maxItems: 1, kinds: ["IMAGE", "VIDEO"], requiresPublicHttpsUrl: false },
  content: { supportsTextOnly: true, maxTextLength: null },
  externalVerification: "NOT_IMPLEMENTED",
};

export const TIKTOK_PLATFORM_DEFINITION: PlatformDefinition = {
  provider: "TIKTOK",
  platform: "tiktok",
  accountTypes: ["TIKTOK_ACCOUNT"],
  capabilities: [],
  defaultPublishAdapter: null,
  supportedPublishAdapters: [],
  media: { required: true, minItems: 1, maxItems: 1, kinds: ["VIDEO"], requiresPublicHttpsUrl: true },
  content: { supportsTextOnly: false, maxTextLength: null },
  externalVerification: "NOT_IMPLEMENTED",
};

export const YOUTUBE_PLATFORM_DEFINITION: PlatformDefinition = {
  provider: "GOOGLE",
  platform: "youtube",
  accountTypes: ["YOUTUBE_CHANNEL"],
  capabilities: [],
  defaultPublishAdapter: null,
  supportedPublishAdapters: [],
  media: { required: true, minItems: 1, maxItems: 1, kinds: ["VIDEO"], requiresPublicHttpsUrl: false },
  content: { supportsTextOnly: false, maxTextLength: null },
  externalVerification: "NOT_IMPLEMENTED",
};
