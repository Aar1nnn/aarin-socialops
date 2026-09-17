-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ClientMode" AS ENUM ('DEMO', 'DRAFT', 'LIVE');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('CONFIRMED', 'PROPOSED', 'MISSING');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "AssetVariant" AS ENUM ('ORIGINAL', 'DERIVED');

-- CreateEnum
CREATE TYPE "CapabilityStatus" AS ENUM ('UNCONFIGURED', 'UNVERIFIED', 'VERIFIED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'REVIEW_PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'SCHEDULED', 'RUNNING', 'PUBLISHED', 'WAITING_CONFIGURATION', 'FAILED', 'UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublishJobStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY', 'WAITING_CONFIGURATION', 'PUBLISHED', 'FAILED', 'UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DataAvailability" AS ENUM ('AVAILABLE', 'NOT_FETCHED', 'UNSUPPORTED', 'READ_FAILED');

-- CreateEnum
CREATE TYPE "DataKind" AS ENUM ('REAL', 'MOCK');

-- CreateEnum
CREATE TYPE "LeadCategory" AS ENUM ('PROCUREMENT', 'WHOLESALE', 'INQUIRY', 'CATALOG_REQUEST', 'SUPPLY_REQUEST', 'GENERAL', 'SPAM');

-- CreateEnum
CREATE TYPE "LeadPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "LeadHandoffStatus" AS ENUM ('NEW', 'REPLIED', 'HANDED_OFF', 'WAITING_FEEDBACK', 'CLOSED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ManualTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ManualTaskPriority" AS ENUM ('NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('NORMAL', 'URGENT');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('TEXT_GENERATION', 'IMAGE_GENERATION', 'SOCIAL_PUBLISHING', 'METRICS', 'INTERACTIONS', 'NOTIFICATION', 'WORDPRESS', 'OBJECT_STORAGE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeClientId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "ClientMode" NOT NULL DEFAULT 'DEMO',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "targetMarkets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productFocus" TEXT,
    "brandGuidelines" TEXT,
    "contactDetails" JSONB,
    "usageMonthlyLimit" INTEGER NOT NULL DEFAULT 100000,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "configurationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchRecord" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "observations" JSONB NOT NULL,
    "inferences" JSONB NOT NULL,
    "experiments" JSONB NOT NULL,
    "limitations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'OPERATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modelNumber" TEXT,
    "dataVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "FactStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductField" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "status" "FactStatus" NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "parentAssetId" TEXT,
    "kind" "AssetKind" NOT NULL,
    "variant" "AssetVariant" NOT NULL DEFAULT 'ORIGINAL',
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "storageProvider" TEXT NOT NULL DEFAULT 'local',
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAsset" (
    "productId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'PRODUCT_MEDIA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAsset_pkey" PRIMARY KEY ("productId","assetId")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "credentialRef" TEXT,
    "publishCapability" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "metricsCapability" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "commentsCapability" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "messagesCapability" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "groupsCapability" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPolicy" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "maxTextLength" INTEGER,
    "allowedFormats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "modelConfig" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPlan" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT,
    "theme" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "channels" TEXT[],
    "assetNeeds" TEXT,
    "plannedAt" TIMESTAMP(3),
    "marketScope" TEXT,
    "isGenericDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentItem" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentVersion" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentItemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "title" TEXT,
    "productDataVersion" INTEGER,
    "promptVersionId" TEXT NOT NULL,
    "generator" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "generationLabel" TEXT NOT NULL,
    "sourceFacts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentVersionAsset" (
    "contentVersionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentVersionAsset_pkey" PRIMARY KEY ("contentVersionId","assetId")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "PublishJobStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "remotePostId" TEXT,
    "remotePostUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" TEXT NOT NULL,
    "publishJobId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'DISPATCHING',
    "requestFingerprint" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "remotePostId" TEXT,
    "remotePostUrl" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "numericValue" DECIMAL(65,30),
    "availability" "DataAvailability" NOT NULL,
    "dataKind" "DataKind" NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT,
    "platform" TEXT NOT NULL,
    "platformRecordId" TEXT NOT NULL,
    "interactionType" TEXT NOT NULL,
    "authorHandle" TEXT,
    "authorDisplay" TEXT,
    "body" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "category" "LeadCategory" NOT NULL,
    "priority" "LeadPriority" NOT NULL,
    "rationale" TEXT NOT NULL,
    "relatedProductId" TEXT,
    "verificationNeeded" TEXT,
    "handoffStatus" "LeadHandoffStatus" NOT NULL DEFAULT 'NEW',
    "salesFeedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualTask" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentItemId" TEXT,
    "leadId" TEXT,
    "accountId" TEXT,
    "triggerReason" TEXT NOT NULL,
    "priority" "ManualTaskPriority" NOT NULL DEFAULT 'NORMAL',
    "suggestedDueAt" TIMESTAMP(3),
    "sourceMaterial" JSONB NOT NULL,
    "requiredAction" TEXT NOT NULL,
    "completionCriteria" TEXT NOT NULL,
    "continuationStep" TEXT NOT NULL,
    "status" "ManualTaskStatus" NOT NULL DEFAULT 'TODO',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationReport" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "facts" JSONB NOT NULL,
    "dataLimitations" JSONB NOT NULL,
    "hypotheses" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reportId" TEXT,
    "hypothesis" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "credentialRef" TEXT,
    "status" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InAppNotification" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InAppNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConfig" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "IntegrationType" NOT NULL,
    "provider" TEXT NOT NULL,
    "credentialRef" TEXT,
    "status" "CapabilityStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "publicConfig" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "inputUnits" INTEGER NOT NULL DEFAULT 0,
    "outputUnits" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DECIMAL(65,30),
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Client_slug_key" ON "Client"("slug");

-- CreateIndex
CREATE INDEX "ResearchRecord_clientId_kind_observedAt_idx" ON "ResearchRecord"("clientId", "kind", "observedAt");

-- CreateIndex
CREATE INDEX "ClientMembership_clientId_idx" ON "ClientMembership"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMembership_userId_clientId_key" ON "ClientMembership"("userId", "clientId");

-- CreateIndex
CREATE INDEX "Product_clientId_updatedAt_idx" ON "Product"("clientId", "updatedAt");

-- CreateIndex
CREATE INDEX "ProductField_clientId_status_idx" ON "ProductField"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductField_productId_key_key" ON "ProductField"("productId", "key");

-- CreateIndex
CREATE INDEX "Asset_clientId_createdAt_idx" ON "Asset"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_clientId_checksum_storageKey_key" ON "Asset"("clientId", "checksum", "storageKey");

-- CreateIndex
CREATE INDEX "ProductAsset_clientId_idx" ON "ProductAsset"("clientId");

-- CreateIndex
CREATE INDEX "SocialAccount_clientId_platform_idx" ON "SocialAccount"("clientId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_clientId_platform_displayName_key" ON "SocialAccount"("clientId", "platform", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPolicy_clientId_platform_key" ON "PlatformPolicy"("clientId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_clientId_capability_version_key" ON "PromptVersion"("clientId", "capability", "version");

-- CreateIndex
CREATE INDEX "ContentPlan_clientId_plannedAt_idx" ON "ContentPlan"("clientId", "plannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentItem_currentVersionId_key" ON "ContentItem"("currentVersionId");

-- CreateIndex
CREATE INDEX "ContentItem_clientId_status_idx" ON "ContentItem"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentItem_planId_accountId_key" ON "ContentItem"("planId", "accountId");

-- CreateIndex
CREATE INDEX "ContentVersion_clientId_createdAt_idx" ON "ContentVersion"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVersion_contentItemId_version_key" ON "ContentVersion"("contentItemId", "version");

-- CreateIndex
CREATE INDEX "ContentVersionAsset_clientId_idx" ON "ContentVersionAsset"("clientId");

-- CreateIndex
CREATE INDEX "Approval_clientId_contentVersionId_accountId_createdAt_idx" ON "Approval"("clientId", "contentVersionId", "accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishJob_idempotencyKey_key" ON "PublishJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishJob_status_nextAttemptAt_idx" ON "PublishJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PublishJob_clientId_createdAt_idx" ON "PublishJob"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishJob_clientId_contentVersionId_accountId_key" ON "PublishJob"("clientId", "contentVersionId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishAttempt_publishJobId_number_key" ON "PublishAttempt"("publishJobId", "number");

-- CreateIndex
CREATE INDEX "MetricSnapshot_clientId_metricKey_fetchedAt_idx" ON "MetricSnapshot"("clientId", "metricKey", "fetchedAt");

-- CreateIndex
CREATE INDEX "Interaction_clientId_occurredAt_idx" ON "Interaction"("clientId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Interaction_clientId_platform_platformRecordId_key" ON "Interaction"("clientId", "platform", "platformRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_interactionId_key" ON "Lead"("interactionId");

-- CreateIndex
CREATE INDEX "Lead_clientId_priority_handoffStatus_idx" ON "Lead"("clientId", "priority", "handoffStatus");

-- CreateIndex
CREATE INDEX "ManualTask_clientId_status_priority_idx" ON "ManualTask"("clientId", "status", "priority");

-- CreateIndex
CREATE INDEX "OperationReport_clientId_generatedAt_idx" ON "OperationReport"("clientId", "generatedAt");

-- CreateIndex
CREATE INDEX "Experiment_clientId_status_idx" ON "Experiment"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_clientId_type_displayName_key" ON "NotificationChannel"("clientId", "type", "displayName");

-- CreateIndex
CREATE INDEX "InAppNotification_clientId_severity_readAt_idx" ON "InAppNotification"("clientId", "severity", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConfig_clientId_type_provider_key" ON "IntegrationConfig"("clientId", "type", "provider");

-- CreateIndex
CREATE INDEX "AuditLog_clientId_createdAt_idx" ON "AuditLog"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLog_clientId_createdAt_idx" ON "UsageLog"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_activeClientId_fkey" FOREIGN KEY ("activeClientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRecord" ADD CONSTRAINT "ResearchRecord_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductField" ADD CONSTRAINT "ProductField_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_parentAssetId_fkey" FOREIGN KEY ("parentAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAsset" ADD CONSTRAINT "ProductAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAsset" ADD CONSTRAINT "ProductAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPolicy" ADD CONSTRAINT "PlatformPolicy_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentItem" ADD CONSTRAINT "ContentItem_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ContentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersionAsset" ADD CONSTRAINT "ContentVersionAsset_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersionAsset" ADD CONSTRAINT "ContentVersionAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_publishJobId_fkey" FOREIGN KEY ("publishJobId") REFERENCES "PublishJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "Interaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTask" ADD CONSTRAINT "ManualTask_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationReport" ADD CONSTRAINT "OperationReport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InAppNotification" ADD CONSTRAINT "InAppNotification_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
