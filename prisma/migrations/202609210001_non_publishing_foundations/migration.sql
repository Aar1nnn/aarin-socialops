CREATE TYPE "AnalyticsFreshnessStatus" AS ENUM ('FRESH', 'STALE', 'SYNCING', 'FAILED');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "BrandProfile" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "businessSummary" TEXT,
    "positioning" TEXT,
    "audience" TEXT,
    "tone" TEXT,
    "voiceTraits" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "goals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "contentLanguages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "imageStyle" TEXT,
    "bannedPhrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requiredMentions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ctaRules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsSyncState" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT,
    "scope" TEXT NOT NULL,
    "status" "AnalyticsFreshnessStatus" NOT NULL DEFAULT 'STALE',
    "lastStartedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalyticsSyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrandProfile_clientId_key" ON "BrandProfile"("clientId");
CREATE UNIQUE INDEX "AnalyticsSyncState_clientId_accountId_scope_key" ON "AnalyticsSyncState"("clientId", "accountId", "scope");
CREATE INDEX "AnalyticsSyncState_clientId_status_updatedAt_idx" ON "AnalyticsSyncState"("clientId", "status", "updatedAt");
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channelId_key" ON "NotificationDelivery"("notificationId", "channelId");
CREATE INDEX "NotificationDelivery_status_updatedAt_idx" ON "NotificationDelivery"("status", "updatedAt");

ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsSyncState" ADD CONSTRAINT "AnalyticsSyncState_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "InAppNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
