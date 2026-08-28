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
}): OperationalSnapshot {
  const count = (type: string) => options.eventTypes.filter((candidate) => candidate === type).length;
  const successfulRuns = options.runSummaries.filter((run) => run.status === "success").length;
  const recoveredRuns = options.runSummaries.filter((run) => run.recovered).length;
  return {
    windowHours: 24,
    ticketsIssued: count("ticket_issued"),
    ticketsVerified: count("ticket_verified"),
    ticketsRejected: count("ticket_rejected"),
    rateLimited: count("ticket_rate_limited"),
    agentRuns: options.runSummaries.length,
    successfulRuns,
    recoveredRuns,
    successRate: options.runSummaries.length === 0 ? 0 : successfulRuns / options.runSummaries.length,
    currentKeyVersion: options.currentKeyVersion,
    staleEvidenceRows: options.staleEvidenceRows,
    previousKeyConfigured: options.previousKeyConfigured,
    invocationRateLimit: INVOCATION_RATE_LIMIT,
  };
}
