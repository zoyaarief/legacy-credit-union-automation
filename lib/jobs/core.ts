export type JobStatus = "queued" | "running" | "human_required" | "success" | "business_outcome" | "failure" | "cancelled";

export type AutomationJob = {
  jobId: string;
  status: JobStatus;
  capabilityName: string;
  capabilityVersion: string;
  variantId: string;
  artifactHash: string;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
};
