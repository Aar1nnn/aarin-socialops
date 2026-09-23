-- Phase B extends the existing Asset and Calendar sources of truth.
CREATE UNIQUE INDEX "Asset_id_clientId_key" ON "Asset"("id", "clientId");

CREATE TABLE "AssetTag" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssetTagLink" (
    "assetId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetTagLink_pkey" PRIMARY KEY ("assetId", "tagId")
);

CREATE TABLE "ScheduleQueue" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "horizonDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScheduleQueue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduleSlot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduleSlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssetTag_clientId_normalizedName_key" ON "AssetTag"("clientId", "normalizedName");
CREATE UNIQUE INDEX "AssetTag_id_clientId_key" ON "AssetTag"("id", "clientId");
CREATE INDEX "AssetTag_clientId_name_idx" ON "AssetTag"("clientId", "name");
CREATE INDEX "AssetTagLink_clientId_tagId_idx" ON "AssetTagLink"("clientId", "tagId");
CREATE UNIQUE INDEX "ScheduleQueue_clientId_accountId_name_key" ON "ScheduleQueue"("clientId", "accountId", "name");
CREATE UNIQUE INDEX "ScheduleQueue_id_clientId_key" ON "ScheduleQueue"("id", "clientId");
CREATE INDEX "ScheduleQueue_clientId_enabled_idx" ON "ScheduleQueue"("clientId", "enabled");
CREATE UNIQUE INDEX "ScheduleSlot_queueId_dayOfWeek_hour_minute_key" ON "ScheduleSlot"("queueId", "dayOfWeek", "hour", "minute");
CREATE INDEX "ScheduleSlot_clientId_queueId_enabled_idx" ON "ScheduleSlot"("clientId", "queueId", "enabled");

ALTER TABLE "AssetTag" ADD CONSTRAINT "AssetTag_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetTagLink" ADD CONSTRAINT "AssetTagLink_assetId_clientId_fkey" FOREIGN KEY ("assetId", "clientId") REFERENCES "Asset"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetTagLink" ADD CONSTRAINT "AssetTagLink_tagId_clientId_fkey" FOREIGN KEY ("tagId", "clientId") REFERENCES "AssetTag"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleQueue" ADD CONSTRAINT "ScheduleQueue_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleQueue" ADD CONSTRAINT "ScheduleQueue_accountId_clientId_fkey" FOREIGN KEY ("accountId", "clientId") REFERENCES "SocialAccount"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_queueId_clientId_fkey" FOREIGN KEY ("queueId", "clientId") REFERENCES "ScheduleQueue"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
