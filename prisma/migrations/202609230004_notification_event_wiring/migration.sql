-- Keep each external notification attempt as immutable delivery evidence.
DROP INDEX "NotificationDelivery_notificationId_channelId_key";

CREATE INDEX "NotificationDelivery_notificationId_channelId_createdAt_idx"
  ON "NotificationDelivery"("notificationId", "channelId", "createdAt");
