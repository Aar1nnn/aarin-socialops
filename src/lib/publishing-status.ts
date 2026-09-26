import { PublishJobStatus } from "@prisma/client";

// Only these states can be changed before an external publish outcome is known.
export const MUTABLE_SCHEDULED_JOB_STATUSES: PublishJobStatus[] = [
  PublishJobStatus.PENDING,
  PublishJobStatus.RETRY,
  PublishJobStatus.WAITING_CONFIGURATION,
  PublishJobStatus.MANUAL_PENDING,
];

export const CONFLICT_JOB_STATUSES: PublishJobStatus[] = [
  ...MUTABLE_SCHEDULED_JOB_STATUSES,
  PublishJobStatus.RUNNING,
];

export const OPEN_MANUAL_TASK_STATUSES = ["TODO", "IN_PROGRESS", "WAITING_EXTERNAL"] as const;
