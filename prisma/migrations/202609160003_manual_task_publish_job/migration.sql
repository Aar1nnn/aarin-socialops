ALTER TABLE "ManualTask" ADD COLUMN "publishJobId" TEXT;

CREATE INDEX "ManualTask_clientId_publishJobId_idx" ON "ManualTask"("clientId", "publishJobId");

ALTER TABLE "ManualTask"
ADD CONSTRAINT "ManualTask_publishJobId_fkey"
FOREIGN KEY ("publishJobId") REFERENCES "PublishJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
