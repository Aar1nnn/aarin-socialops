import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { createProduct, uploadAsset } from "../src/services/product-service";
import {
  generateContentPlan,
  reviewContent,
  schedulePublication,
  submitForReview,
} from "../src/services/content-service";
import { claimNextJob, processPublishJob } from "../src/services/publish-worker-service";
import { importInteraction, updateLeadStatus } from "../src/services/interaction-service";
import { createMockMetricSnapshots, generateOperationReport } from "../src/services/report-service";

async function main() {
  const client = await db.client.findUniqueOrThrow({ where: { slug: "demo-furniture-export" } });
  const membership = await db.clientMembership.findFirstOrThrow({
    where: { clientId: client.id, role: "OWNER" },
  });
  const context = { clientId: client.id, userId: membership.userId, role: membership.role };
  const runId = randomUUID().slice(0, 8);
  const product = await createProduct(context, {
    name: `E2E Demo Dining Chair ${runId}`,
    modelNumber: `E2E-${runId}`,
    fields: [
      { key: "material", value: "powder-coated steel frame", status: "CONFIRMED", source: "E2E customer sheet" },
      { key: "dimensions", value: "", status: "MISSING", source: "" },
      { key: "supply_scope", value: "wholesale supply", status: "CONFIRMED", source: "E2E customer sheet" },
    ],
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const asset = await uploadAsset(context, {
    productId: product.id,
    file: new File([png], `e2e-${runId}.png`, { type: "image/png" }),
  });
  const generated = await generateContentPlan(context, {
    productId: product.id,
    theme: "Distributor product introduction",
    objective: "Qualified wholesale enquiries",
    platforms: ["facebook", "instagram", "tiktok", "linkedin"],
    assetIds: [asset.id],
  });
  const jobIds: string[] = [];
  for (const item of generated.items) {
    await submitForReview(context, item.id);
    await reviewContent(context, item.id, "APPROVED", "E2E operator approval");
    const first = await schedulePublication(context, item.id);
    const duplicate = await schedulePublication(context, item.id);
    if (first.id !== duplicate.id) throw new Error("idempotency check failed");
    jobIds.push(first.id);
  }
  for (let index = 0; index < 20; index += 1) {
    const remaining = await db.publishJob.count({ where: { id: { in: jobIds }, status: { not: "PUBLISHED" } } });
    if (remaining === 0) break;
    const claimed = await claimNextJob(`e2e-worker-${runId}`);
    if (!claimed) break;
    await processPublishJob(claimed.id);
  }
  const imported = await importInteraction(context, {
    platform: "facebook",
    platformRecordId: `e2e-interaction-${runId}`,
    interactionType: "COMMENT",
    authorHandle: "demo_distributor",
    body: "We are a distributor. Please send your wholesale catalog, MOQ and lead time.",
    occurredAt: new Date(),
  });
  if (!imported.lead) throw new Error("lead classification failed");
  await updateLeadStatus(context, imported.lead.id, "HANDED_OFF", "E2E: manually handed off to client owner");
  await createMockMetricSnapshots(context);
  const report = await generateOperationReport(context);
  const jobs = await db.publishJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, status: true, simulated: true, remotePostId: true } });
  console.log(JSON.stringify({
    runId,
    client: client.name,
    productId: product.id,
    assetId: asset.id,
    generation: generated.generation,
    contentItems: generated.items.length,
    jobs,
    lead: { id: imported.lead.id, category: imported.lead.category, status: "HANDED_OFF", original: imported.interaction.body },
    report: { id: report.id, simulated: report.simulated, limitations: report.dataLimitations },
  }, null, 2));
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack : error);
    await db.$disconnect();
    process.exit(1);
  });
