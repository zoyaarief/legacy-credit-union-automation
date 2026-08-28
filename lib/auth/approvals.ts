import type { Capability } from "@/lib/automation/core";

export type ApprovalDecision = "approve" | "reject";
export type ApprovalState = "draft" | "pending" | "approved" | "rejected";

export function approvalPolicy(capability: Capability) {
  const separationRequired = capability.policy.risk === "irreversible" || capability.policy.requiresHumanApproval;
  return {
    riskClass: capability.policy.risk,
    requiredApprovals: separationRequired ? 2 : 1,
    separationRequired,
  } as const;
}

export function approvalState(approvals: number, rejections: number, requiredApprovals: number): ApprovalState {
  if (rejections > 0) return "rejected";
  if (approvals >= requiredApprovals) return "approved";
  return approvals > 0 ? "pending" : "draft";
}
