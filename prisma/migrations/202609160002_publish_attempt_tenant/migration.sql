ALTER TABLE "PublishAttempt" ADD COLUMN "clientId" TEXT;

UPDATE "PublishAttempt" AS attempt
SET "clientId" = job."clientId"
FROM "PublishJob" AS job
WHERE attempt."publishJobId" = job."id";

ALTER TABLE "PublishAttempt" ALTER COLUMN "clientId" SET NOT NULL;

CREATE INDEX "PublishAttempt_clientId_startedAt_idx" ON "PublishAttempt"("clientId", "startedAt");

ALTER TABLE "PublishAttempt"
ADD CONSTRAINT "PublishAttempt_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
