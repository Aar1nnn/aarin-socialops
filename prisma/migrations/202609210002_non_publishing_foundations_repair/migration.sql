-- Idempotent repair for local/shared databases that may have recorded the
-- preceding migration name before receiving its complete schema changes.
DO $$ BEGIN
    CREATE TYPE "AiReviewVerdict" AS ENUM ('PASS', 'NEEDS_REVISION');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "BrandProfile" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "businessSummary" TEXT NOT NULL,
    "positioning" TEXT,
    "audience" TEXT,
    "tone" TEXT,
    "voiceTraits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "goals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageStyle" TEXT,
    "bannedPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredMentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ctaRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiContentReview" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "verdict" "AiReviewVerdict" NOT NULL,
    "score" INTEGER,
    "issues" JSONB NOT NULL,
    "reviewer" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiContentReview_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MetricSnapshot" ADD COLUMN IF NOT EXISTS "contentItemId" TEXT;
ALTER TABLE "NotificationChannel" ADD COLUMN IF NOT EXISTS "publicConfig" JSONB;
ALTER TABLE "NotificationChannel" ADD COLUMN IF NOT EXISTS "lastDispatchAt" TIMESTAMP(3);
ALTER TABLE "NotificationChannel" ADD COLUMN IF NOT EXISTS "lastError" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BrandProfile_clientId_key" ON "BrandProfile"("clientId");
CREATE INDEX IF NOT EXISTS "BrandProfile_clientId_updatedAt_idx" ON "BrandProfile"("clientId", "updatedAt");
CREATE INDEX IF NOT EXISTS "AiContentReview_clientId_contentVersionId_createdAt_idx" ON "AiContentReview"("clientId", "contentVersionId", "createdAt");
CREATE INDEX IF NOT EXISTS "MetricSnapshot_clientId_contentItemId_fetchedAt_idx" ON "MetricSnapshot"("clientId", "contentItemId", "fetchedAt");

DO $$ BEGIN
    ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "AiContentReview" ADD CONSTRAINT "AiContentReview_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "AiContentReview" ADD CONSTRAINT "AiContentReview_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
