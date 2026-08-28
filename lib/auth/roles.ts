import type { D1Database } from "@/db";
export type AutomationRole = "admin" | "reviewer" | "operator" | "agent" | "viewer";
export const ROLE_CAPABILITIES: Record<AutomationRole, string[]> = {
  admin: ["manage_roles", "review_artifacts", "operate_jobs", "enqueue_jobs", "invoke_capabilities", "view_operations", "dispatch_alerts"], reviewer: ["review_artifacts", "view_operations"], operator: ["operate_jobs", "view_operations"], agent: ["enqueue_jobs", "invoke_capabilities"], viewer: [],
};
export function configuredAdmins(value?: string) { return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean)); }
export async function resolveRole(database: D1Database, subjectId: string, adminIds: Set<string>): Promise<AutomationRole> {
  if (adminIds.has(subjectId) || subjectId === "local-demo-user") return "admin";
  const result = await database.prepare("SELECT role FROM user_roles WHERE subject_id = ?").bind(subjectId).all<{ role: AutomationRole }>();
  return result.results?.[0]?.role ?? "viewer";
}
export function can(role: AutomationRole, capability: string) { return ROLE_CAPABILITIES[role].includes(capability); }
