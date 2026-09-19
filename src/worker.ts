import { db } from "./lib/db";
import { claimNextJob, processPublishJob, recoverStaleJobs } from "./services/publish-worker-service";
import { safeErrorMessage } from "./lib/token-vault";

const once = process.argv.includes("--once");
const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
const pollMs = Number(process.env.WORKER_POLL_MS || 2000);
const lockTimeout = Number(process.env.JOB_LOCK_TIMEOUT_SECONDS || 60);

async function tick() {
  await recoverStaleJobs(lockTimeout);
  const job = await claimNextJob(workerId);
  if (job) await processPublishJob(job.id);
  return Boolean(job);
}

async function main() {
  if (once) {
    await tick();
    return;
  }
  while (true) {
    const worked = await tick();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main()
  .catch((error) => {
    console.error("worker failed", safeErrorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (once) await db.$disconnect();
  });
