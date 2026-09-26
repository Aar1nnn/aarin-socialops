import type { PublishJobStatus } from "@prisma/client";

export const PUBLISHING_LANES: Array<{ key: string; label: string; statuses: PublishJobStatus[] }> = [
  { key: "queued", label: "排队中", statuses: ["PENDING", "RETRY"] },
  { key: "running", label: "执行中", statuses: ["RUNNING"] },
  { key: "published", label: "已发布", statuses: ["PUBLISHED"] },
  { key: "failed", label: "失败", statuses: ["FAILED"] },
  { key: "unknown", label: "结果待确认", statuses: ["UNKNOWN"] },
  { key: "configuration", label: "待配置", statuses: ["WAITING_CONFIGURATION"] },
];

export function publishingStatusLabel(status: PublishJobStatus) {
  if (status === "PENDING") return "排队中";
  if (status === "RETRY") return "等待重试";
  return undefined;
}

export function safeRemotePostUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
