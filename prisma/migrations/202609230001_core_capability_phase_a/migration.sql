-- Phase A keeps ContentVersion immutable while adding explicit lineage and review evidence.
ALTER TABLE "ContentVersion"
  ADD COLUMN "previousVersionId" TEXT,
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "reason" TEXT;

CREATE UNIQUE INDEX "ContentItem_id_clientId_key" ON "ContentItem"("id", "clientId");
CREATE UNIQUE INDEX "ContentVersion_id_clientId_key" ON "ContentVersion"("id", "clientId");
CREATE INDEX "ContentVersion_previousVersionId_idx" ON "ContentVersion"("previousVersionId");
CREATE INDEX "ContentVersion_createdByUserId_createdAt_idx" ON "ContentVersion"("createdByUserId", "createdAt");

ALTER TABLE "ContentVersion"
  ADD CONSTRAINT "ContentVersion_previousVersionId_fkey"
  FOREIGN KEY ("previousVersionId") REFERENCES "ContentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContentVersion"
  ADD CONSTRAINT "ContentVersion_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReviewComment" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "contentItemId" TEXT NOT NULL,
  "contentVersionId" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "comment" TEXT NOT NULL,
  "reason" TEXT,
  "requestedChanges" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReviewComment_clientId_contentItemId_createdAt_idx"
  ON "ReviewComment"("clientId", "contentItemId", "createdAt");

CREATE INDEX "ReviewComment_clientId_contentVersionId_createdAt_idx"
  ON "ReviewComment"("clientId", "contentVersionId", "createdAt");

ALTER TABLE "ReviewComment"
  ADD CONSTRAINT "ReviewComment_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewComment"
  ADD CONSTRAINT "ReviewComment_contentItemId_clientId_fkey"
  FOREIGN KEY ("contentItemId", "clientId") REFERENCES "ContentItem"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewComment"
  ADD CONSTRAINT "ReviewComment_contentVersionId_clientId_fkey"
  FOREIGN KEY ("contentVersionId", "clientId") REFERENCES "ContentVersion"("id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReviewComment"
  ADD CONSTRAINT "ReviewComment_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
