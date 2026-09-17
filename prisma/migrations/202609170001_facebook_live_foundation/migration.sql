-- CreateEnum
CREATE TYPE "PublishEnvironment" AS ENUM ('SIMULATED', 'LIVE');

-- CreateEnum
CREATE TYPE "FacebookTokenStatus" AS ENUM ('UNCONFIGURED', 'UNVERIFIED', 'VALID', 'EXPIRING', 'EXPIRED', 'REVOKED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "UsageReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "DataAvailability" ADD VALUE 'PERMISSION_DENIED';

-- AlterTable
ALTER TABLE "PublishJob" ADD COLUMN "environment" "PublishEnvironment" NOT NULL DEFAULT 'SIMULATED',
ADD COLUMN "lastQueriedAt" TIMESTAMP(3);

UPDATE "PublishJob" SET "environment" = CASE WHEN "simulated" THEN 'SIMULATED'::"PublishEnvironment" ELSE 'LIVE'::"PublishEnvironment" END;

-- CreateTable
CREATE TABLE "FacebookPageConnection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageName" TEXT,
    "graphApiVersion" TEXT NOT NULL DEFAULT 'v26.0',
    "credentialRef" TEXT NOT NULL,
    "requiredPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pageTasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metricKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenStatus" "FacebookTokenStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "tokenExpiresAt" TIMESTAMP(3),
    "connectionStatus" "CapabilityStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "metricsSyncedAt" TIMESTAMP(3),
    "commentsSyncedAt" TIMESTAMP(3),
    "commentsCursor" TEXT,
    "lastErrorCategory" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FacebookPageConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageReservation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reservedUnits" INTEGER NOT NULL,
    "settledUnits" INTEGER,
    "status" "UsageReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginRateLimit" (
    "keyHash" TEXT NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "windowStarted" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoginRateLimit_pkey" PRIMARY KEY ("keyHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "FacebookPageConnection_accountId_key" ON "FacebookPageConnection"("accountId");
CREATE UNIQUE INDEX "FacebookPageConnection_clientId_pageId_key" ON "FacebookPageConnection"("clientId", "pageId");
CREATE INDEX "FacebookPageConnection_clientId_connectionStatus_idx" ON "FacebookPageConnection"("clientId", "connectionStatus");
CREATE UNIQUE INDEX "UsageReservation_requestKey_key" ON "UsageReservation"("requestKey");
CREATE INDEX "UsageReservation_clientId_status_createdAt_idx" ON "UsageReservation"("clientId", "status", "createdAt");
CREATE INDEX "LoginRateLimit_blockedUntil_idx" ON "LoginRateLimit"("blockedUntil");

-- AddForeignKey
ALTER TABLE "FacebookPageConnection" ADD CONSTRAINT "FacebookPageConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FacebookPageConnection" ADD CONSTRAINT "FacebookPageConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageReservation" ADD CONSTRAINT "UsageReservation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
