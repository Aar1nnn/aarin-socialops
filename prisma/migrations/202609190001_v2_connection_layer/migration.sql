-- V2 connection layer. This migration is additive and keeps the V1
-- FacebookPageConnection path intact for a controlled compatibility period.

CREATE TYPE "Provider" AS ENUM ('META', 'LINKEDIN', 'TIKTOK', 'GOOGLE');
CREATE TYPE "PlatformConnectionStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'TOKEN_EXPIRING', 'TOKEN_EXPIRED', 'PERMISSION_MISSING', 'REVIEW_REQUIRED', 'DISCONNECTED', 'ERROR');

CREATE TABLE "PlatformConnection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalPrincipalId" TEXT,
    "accessTokenCiphertext" TEXT,
    "accessTokenIv" TEXT,
    "accessTokenAuthTag" TEXT,
    "refreshTokenCiphertext" TEXT,
    "refreshTokenIv" TEXT,
    "refreshTokenAuthTag" TEXT,
    "tokenKeyVersion" TEXT NOT NULL DEFAULT 'v1',
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "PlatformConnectionStatus" NOT NULL DEFAULT 'CONNECTING',
    "connectedByUserId" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "returnTo" TEXT,
    "codeVerifierCiphertext" TEXT,
    "codeVerifierIv" TEXT,
    "codeVerifierAuthTag" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SocialAccount"
    ADD COLUMN "platformConnectionId" TEXT,
    ADD COLUMN "accountType" TEXT,
    ADD COLUMN "username" TEXT,
    ADD COLUMN "metadata" JSONB,
    ADD COLUMN "providerCapabilities" JSONB,
    ADD COLUMN "isSelected" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "accessTokenCiphertext" TEXT,
    ADD COLUMN "accessTokenIv" TEXT,
    ADD COLUMN "accessTokenAuthTag" TEXT,
    ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);

ALTER TABLE "PublishJob"
    ADD COLUMN "provider" "Provider",
    ADD COLUMN "platform" TEXT;

UPDATE "PublishJob" AS job
SET "platform" = account."platform",
    "provider" = CASE account."platform"
        WHEN 'facebook' THEN 'META'::"Provider"
        WHEN 'instagram' THEN 'META'::"Provider"
        WHEN 'linkedin' THEN 'LINKEDIN'::"Provider"
        WHEN 'tiktok' THEN 'TIKTOK'::"Provider"
        ELSE NULL
    END
FROM "SocialAccount" AS account
WHERE account."id" = job."accountId";

CREATE UNIQUE INDEX "PlatformConnection_id_clientId_key" ON "PlatformConnection"("id", "clientId");
CREATE UNIQUE INDEX "PlatformConnection_clientId_provider_externalPrincipalId_key" ON "PlatformConnection"("clientId", "provider", "externalPrincipalId");
CREATE INDEX "PlatformConnection_clientId_provider_status_idx" ON "PlatformConnection"("clientId", "provider", "status");
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");
CREATE INDEX "OAuthState_clientId_provider_expiresAt_idx" ON "OAuthState"("clientId", "provider", "expiresAt");
CREATE INDEX "OAuthState_userId_expiresAt_idx" ON "OAuthState"("userId", "expiresAt");
DROP INDEX "SocialAccount_clientId_platform_displayName_key";
CREATE UNIQUE INDEX "SocialAccount_id_clientId_key" ON "SocialAccount"("id", "clientId");
CREATE UNIQUE INDEX "SocialAccount_clientId_platform_externalAccountId_key" ON "SocialAccount"("clientId", "platform", "externalAccountId");
CREATE INDEX "SocialAccount_platformConnectionId_idx" ON "SocialAccount"("platformConnectionId");

ALTER TABLE "PlatformConnection"
    ADD CONSTRAINT "PlatformConnection_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "PlatformConnection_connectedByUserId_fkey"
    FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OAuthState"
    ADD CONSTRAINT "OAuthState_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "OAuthState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialAccount"
    ADD CONSTRAINT "SocialAccount_platformConnectionId_clientId_fkey"
    FOREIGN KEY ("platformConnectionId", "clientId")
    REFERENCES "PlatformConnection"("id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;
