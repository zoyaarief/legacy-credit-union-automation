import type { ReplayResult } from "./core.ts";

export type StabilityRun = {
  status: ReplayResult["status"];
  attempts: number;
  recovered: boolean;
};

export type StabilityScore = {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  recoveredRuns: number;
  successRate: number;
  label: "stable" | "needs_review" | "unstable";
};

export function scoreStability(runs: StabilityRun[]): StabilityScore {
  const totalRuns = runs.length;
  const successfulRuns = runs.filter((run) => run.status === "success").length;
  const recoveredRuns = runs.filter((run) => run.recovered).length;
  const successRate = totalRuns === 0 ? 0 : successfulRuns / totalRuns;
  const label = totalRuns > 0 && successfulRuns === totalRuns && recoveredRuns === 0
    ? "stable"
    : successRate >= 2 / 3
      ? "needs_review"
      : "unstable";
  return { totalRuns, successfulRuns, failedRuns: totalRuns - successfulRuns, recoveredRuns, successRate, label };
}
