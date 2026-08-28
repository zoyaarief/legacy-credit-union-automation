export const INVOCATION_RATE_LIMIT = 12;
export const INVOCATION_WINDOW_MS = 60_000;

export type OperationalSnapshot = {
  windowHours: 24;
  ticketsIssued: number;
  ticketsVerified: number;
  ticketsRejected: number;
  rateLimited: number;
  agentRuns: number;
  successfulRuns: number;
  recoveredRuns: number;
  successRate: number;
  currentKeyVersion: string;
  staleEvidenceRows: number;
  previousKeyConfigured: boolean;
  invocationRateLimit: number;
  queuedJobs: number;
  humanRequiredJobs: number;
  alerts: Array<{ code: "success_rate_low" | "ticket_rejections_high" | "job_backlog" | "intervention_waiting" | "key_rotation_pending"; severity: "warning" | "critical"; message: string }>;
};

export function rateLimitWindow(now: number) {
  const windowStart = Math.floor(now / INVOCATION_WINDOW_MS) * INVOCATION_WINDOW_MS;
  return { windowStart, resetAt: new Date(windowStart + INVOCATION_WINDOW_MS).toISOString() };
}

export function summarizeOperations(options: {
  eventTypes: string[];
  runSummaries: Array<{ status: string; recovered?: boolean }>;
  currentKeyVersion: string;
  staleEvidenceRows: number;
  previousKeyConfigured: boolean;
  jobStatuses?: string[];
}): OperationalSnapshot {
  const count = (type: string) => options.eventTypes.filter((candidate) => candidate === type).length;
  const successfulRuns = options.runSummaries.filter((run) => run.status === "success").length;
  const recoveredRuns = options.runSummaries.filter((run) => run.recovered).length;
  const queuedJobs = (options.jobStatuses ?? []).filter((status) => status === "queued").length;
  const humanRequiredJobs = (options.jobStatuses ?? []).filter((status) => status === "human_required").length;
  const successRate = options.runSummaries.length === 0 ? 0 : successfulRuns / options.runSummaries.length;
  const alerts: OperationalSnapshot["alerts"] = [];
  if (options.runSummaries.length >= 3 && successRate < 0.9) alerts.push({ code: "success_rate_low", severity: "critical", message: "Agent success rate is below 90%." });
  if (count("ticket_rejected") + count("ticket_rate_limited") >= 3) alerts.push({ code: "ticket_rejections_high", severity: "warning", message: "Ticket rejections or limits exceeded the 24-hour threshold." });
  if (queuedJobs >= 5) alerts.push({ code: "job_backlog", severity: "warning", message: "Five or more automation jobs are waiting." });
  if (humanRequiredJobs > 0) alerts.push({ code: "intervention_waiting", severity: "warning", message: "A durable intervention is waiting for an operator." });
  if (options.staleEvidenceRows > 0) alerts.push({ code: "key_rotation_pending", severity: "critical", message: "Evidence remains encrypted under an older key." });
  return {
    windowHours: 24,
    ticketsIssued: count("ticket_issued"),
    ticketsVerified: count("ticket_verified"),
    ticketsRejected: count("ticket_rejected"),
    rateLimited: count("ticket_rate_limited"),
    agentRuns: options.runSummaries.length,
    successfulRuns,
    recoveredRuns,
    successRate,
    currentKeyVersion: options.currentKeyVersion,
    staleEvidenceRows: options.staleEvidenceRows,
    previousKeyConfigured: options.previousKeyConfigured,
    invocationRateLimit: INVOCATION_RATE_LIMIT,
    queuedJobs,
    humanRequiredJobs,
    alerts,
  };
}
