ALTER TABLE "NotificationDelivery" ADD COLUMN "clientId" TEXT;

UPDATE "NotificationDelivery" AS delivery
SET "clientId" = notification."clientId"
FROM "InAppNotification" AS notification
WHERE notification."id" = delivery."notificationId";

ALTER TABLE "NotificationDelivery" ALTER COLUMN "clientId" SET NOT NULL;

ALTER TABLE "NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_notificationId_fkey";
ALTER TABLE "NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_channelId_fkey";
DROP INDEX "NotificationDelivery_status_updatedAt_idx";

CREATE UNIQUE INDEX "NotificationChannel_id_clientId_key" ON "NotificationChannel"("id", "clientId");
CREATE UNIQUE INDEX "InAppNotification_id_clientId_key" ON "InAppNotification"("id", "clientId");
CREATE INDEX "NotificationDelivery_clientId_status_updatedAt_idx" ON "NotificationDelivery"("clientId", "status", "updatedAt");

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_clientId_fkey" FOREIGN KEY ("notificationId", "clientId") REFERENCES "InAppNotification"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_channelId_clientId_fkey" FOREIGN KEY ("channelId", "clientId") REFERENCES "NotificationChannel"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
