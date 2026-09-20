import type { Provider } from "@prisma/client";

export type AuthorizationRequest = {
  state: string;
  redirectUri: string;
  codeChallenge?: string;
};

export type AuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  scopes: string[];
};

export type DiscoveredPlatformAccount = {
  externalAccountId: string;
  platform: string;
  accountType: string;
  displayName: string;
  username?: string;
  accessToken: string;
  accessTokenExpiresAt?: Date;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type AccountDiscovery = {
  externalPrincipalId: string;
  grantedScopes: string[];
  accounts: DiscoveredPlatformAccount[];
};

export interface PlatformAuthAdapter {
  readonly provider: Provider;
  buildAuthorizationUrl(request: AuthorizationRequest): URL;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<AuthTokenSet>;
  discoverAccounts(accessToken: string): Promise<AccountDiscovery>;
  refresh?(refreshToken: string): Promise<AuthTokenSet>;
  revoke?(accessToken: string): Promise<void>;
}

export class PlatformAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlatformAuthError";
  }
}
