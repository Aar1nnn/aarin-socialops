-- Claim notification deliveries with a short lease so external I/O happens
-- outside database transactions and abandoned PENDING work can be recovered.
ALTER TABLE "NotificationDelivery"
ADD COLUMN "lockedAt" TIMESTAMP(3),
ADD COLUMN "lockedBy" TEXT;

CREATE INDEX "NotificationDelivery_status_lockedAt_createdAt_idx"
ON "NotificationDelivery"("status", "lockedAt", "createdAt");
