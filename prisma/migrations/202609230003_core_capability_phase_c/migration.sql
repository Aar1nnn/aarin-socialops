-- Phase C adds notification routing configuration and inbox dedupe metadata.
CREATE TABLE "NotificationRule" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "channelType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "InAppNotification"
  ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'HIGH_PRIORITY_TASK',
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastOccurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "NotificationRule_clientId_eventType_severity_channelType_key" ON "NotificationRule"("clientId", "eventType", "severity", "channelType");
CREATE INDEX "NotificationRule_clientId_enabled_eventType_idx" ON "NotificationRule"("clientId", "enabled", "eventType");
CREATE UNIQUE INDEX "InAppNotification_clientId_dedupeKey_key" ON "InAppNotification"("clientId", "dedupeKey");
CREATE INDEX "InAppNotification_clientId_eventType_lastOccurredAt_idx" ON "InAppNotification"("clientId", "eventType", "lastOccurredAt");

ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
