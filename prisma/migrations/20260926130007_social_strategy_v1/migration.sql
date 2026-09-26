-- CreateEnum
CREATE TYPE "SocialStrategyStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "ContentPlan" ADD COLUMN     "socialStrategyId" TEXT;

-- CreateTable
CREATE TABLE "SocialStrategy" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SocialStrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialStrategy_clientId_status_createdAt_idx" ON "SocialStrategy"("clientId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialStrategy_clientId_version_key" ON "SocialStrategy"("clientId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SocialStrategy_id_clientId_key" ON "SocialStrategy"("id", "clientId");

-- CreateIndex
CREATE INDEX "ContentPlan_socialStrategyId_clientId_idx" ON "ContentPlan"("socialStrategyId", "clientId");

-- AddForeignKey
ALTER TABLE "SocialStrategy" ADD CONSTRAINT "SocialStrategy_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialStrategy" ADD CONSTRAINT "SocialStrategy_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialStrategy" ADD CONSTRAINT "SocialStrategy_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_socialStrategyId_clientId_fkey" FOREIGN KEY ("socialStrategyId", "clientId") REFERENCES "SocialStrategy"("id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;
