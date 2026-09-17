import { deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { createProduct, uploadAsset } from "../src/services/product-service";
import { generateContentPlan, reviewContent, schedulePublication, submitForReview } from "../src/services/content-service";
import { claimPublishJob, processPublishJob } from "../src/services/publish-worker-service";
import { configureFacebookPage, queryFacebookPublish, syncFacebookComments, syncFacebookPostMetrics, validateFacebookPage } from "../src/services/facebook-service";
import { updateLeadStatus } from "../src/services/interaction-service";

const confirmation = "YES_PUBLISH_TO_DEDICATED_TEST_PAGE";
const testClientSlug = "facebook-phase2-test";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function testPng(width = 600, height = 315) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      row[offset] = 24;
      row[offset + 1] = 83 + Math.floor((x / width) * 80);
      row[offset + 2] = 150 + Math.floor((y / height) * 70);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

async function ensureTestContext(pageId: string) {
  const operator = await db.user.findFirst({ include: { memberships: true } });
  if (!operator) throw new Error("没有本地运营者，请先运行 pnpm db:seed");
  const client = await db.client.upsert({
    where: { slug: testClientSlug },
    update: { mode: "LIVE", isDemo: false, configurationStatus: "FACEBOOK_PHASE2_TEST_ONLY" },
    create: { slug: testClientSlug, name: "Facebook 第二阶段专用测试客户", mode: "LIVE", isDemo: false, configurationStatus: "FACEBOOK_PHASE2_TEST_ONLY", targetMarkets: [], productFocus: "仅用于 Facebook 集成验收的测试内容" },
  });
  await db.clientMembership.upsert({ where: { userId_clientId: { userId: operator.id, clientId: client.id } }, update: { role: "OWNER" }, create: { userId: operator.id, clientId: client.id, role: "OWNER" } });
  let account = await db.socialAccount.findFirst({ where: { clientId: client.id, platform: "facebook" } });
  if (!account) account = await db.socialAccount.create({ data: { clientId: client.id, platform: "facebook", displayName: "[测试] Facebook Page" } });
  await db.promptVersion.upsert({
    where: { clientId_capability_version: { clientId: client.id, capability: "multi_platform_content", version: "facebook-live-e2e-1" } },
    update: { active: true },
    create: { clientId: client.id, capability: "multi_platform_content", version: "facebook-live-e2e-1", instruction: "只使用确认事实；输出必须保留 [PHASE2 TEST]；不得回复、私信或报价。", schemaName: "GeneratedDrafts", modelConfig: { testOnly: true } },
  });
  await db.platformPolicy.upsert({ where: { clientId_platform: { clientId: client.id, platform: "facebook" } }, update: {}, create: { clientId: client.id, platform: "facebook", source: "Facebook Phase 2 live acceptance", allowedFormats: ["IMAGE", "VIDEO"] } });
  const context = { clientId: client.id, userId: operator.id, role: "OWNER" as const };
  await configureFacebookPage(context, { accountId: account.id, pageId, graphApiVersion: process.env.FACEBOOK_GRAPH_API_VERSION || "v26.0", credentialRef: "env:FACEBOOK_TEST_PAGE_ACCESS_TOKEN", requiredPermissions: ["pages_manage_posts", "pages_read_engagement", "pages_read_user_content"], metricKeys: [] });
  await validateFacebookPage(context, account.id);
  return { client, account, context };
}

async function publishStage() {
  if (process.env.FACEBOOK_LIVE_E2E_CONFIRM !== confirmation) throw new Error(`真实发布被阻止。只有设置 FACEBOOK_LIVE_E2E_CONFIRM=${confirmation} 才会向专用测试 Page 发帖。`);
  const pageId = requiredEnv("FACEBOOK_TEST_PAGE_ID");
  requiredEnv("FACEBOOK_TEST_PAGE_ACCESS_TOKEN");
  const { context, account } = await ensureTestContext(pageId);
  const runId = randomUUID().slice(0, 8);
  const product = await createProduct(context, { name: `[PHASE2 TEST] Facebook integration ${runId}`, modelNumber: `FB-TEST-${runId}`, fields: [{ key: "test_scope", value: "Facebook Page integration acceptance only", status: "CONFIRMED", source: "operator-created phase 2 acceptance fixture" }] });
  const bytes = testPng();
  const asset = await uploadAsset(context, { productId: product.id, file: new File([bytes], `facebook-phase2-test-${runId}.png`, { type: "image/png" }) });
  const generated = await generateContentPlan(context, { productId: product.id, theme: `[PHASE2 TEST] Page publishing ${runId}`, objective: "Verify the dedicated test Page integration; not commercial promotion", platforms: ["facebook"], assetIds: [asset.id] });
  const item = generated.items[0];
  await submitForReview(context, item.id);
  await reviewContent(context, item.id, "APPROVED", `[PHASE2 TEST] explicit operator approval ${runId}`);
  const first = await schedulePublication(context, item.id);
  const duplicate = await schedulePublication(context, item.id);
  if (first.id !== duplicate.id) throw new Error("重复排期产生了不同任务，已停止真实发布。 ");
  const claimed = await claimPublishJob(first.id, `facebook-live-e2e-${runId}`);
  if (!claimed) throw new Error("无法领取专用测试发布任务。 ");
  const published = await processPublishJob(first.id);
  if (published.status !== "PUBLISHED" || !published.remotePostId) throw new Error(`真实发布未确认成功：${published.status} ${published.lastErrorCode || ""}`);
  const queried = await queryFacebookPublish(context, published.id);
  const metrics = await syncFacebookPostMetrics(context, published.id);
  if (!metrics.some((metric) => metric.availability === "AVAILABLE" && metric.dataKind === "REAL")) throw new Error("没有读取到任何真实可用帖子指标。 ");
  console.log(JSON.stringify({ stage: "publish", runId, clientSlug: testClientSlug, pageId: account.externalAccountId || pageId, contentItemId: item.id, publishJobId: first.id, duplicateScheduleReusedJob: true, status: queried.status, environment: queried.environment, remotePostId: queried.remotePostId, remotePostUrl: queried.remotePostUrl, publishedAt: queried.publishedAt, realMetrics: metrics.map((metric) => ({ key: metric.metricKey, value: metric.numericValue?.toString(), availability: metric.availability, source: metric.source, fetchedAt: metric.fetchedAt })) }, null, 2));
  console.log("下一步：请在该测试帖下人工评论： [PHASE2 TEST] Please send your wholesale catalog and MOQ. 然后运行 FACEBOOK_LIVE_E2E_STAGE=complete pnpm facebook:live:e2e");
}

async function completeStage() {
  const pageId = requiredEnv("FACEBOOK_TEST_PAGE_ID");
  requiredEnv("FACEBOOK_TEST_PAGE_ACCESS_TOKEN");
  const { context, account } = await ensureTestContext(pageId);
  const job = await db.publishJob.findFirst({ where: { clientId: context.clientId, accountId: account.id, environment: "LIVE", status: "PUBLISHED", remotePostId: { not: null } }, orderBy: { publishedAt: "desc" } });
  if (!job) throw new Error("没有可用于完成验收的真实 Facebook 帖子。 ");
  const sync = await syncFacebookComments(context, job.id);
  const lead = await db.lead.findFirst({ where: { clientId: context.clientId, interaction: { accountId: account.id, body: { contains: "[PHASE2 TEST]" } } }, include: { interaction: true }, orderBy: { createdAt: "desc" } });
  if (!lead) throw new Error("尚未读取到带 [PHASE2 TEST] 且含采购意图的测试评论。系统没有自动创建虚假评论。 ");
  await updateLeadStatus(context, lead.id, "HANDED_OFF", "[PHASE2 TEST] 人工跟进任务已完成并记录为测试交接");
  const completedTasks = await db.manualTask.count({ where: { clientId: context.clientId, leadId: lead.id, status: "COMPLETED" } });
  if (!completedTasks) throw new Error("测试评论对应的人工跟进任务尚未完成。 ");
  console.log(JSON.stringify({ stage: "complete", clientSlug: testClientSlug, publishJobId: job.id, remotePostId: job.remotePostId, commentSync: sync, interactionId: lead.interactionId, originalComment: lead.interaction.body, leadId: lead.id, leadStatus: "HANDED_OFF", completedManualTasks: completedTasks }, null, 2));
}

const stage = process.env.FACEBOOK_LIVE_E2E_STAGE || "publish";
(stage === "publish" ? publishStage() : stage === "complete" ? completeStage() : Promise.reject(new Error("FACEBOOK_LIVE_E2E_STAGE 只能是 publish 或 complete")))
  .then(() => db.$disconnect())
  .catch(async (error) => { console.error(error instanceof Error ? error.message : error); await db.$disconnect(); process.exit(1); });
