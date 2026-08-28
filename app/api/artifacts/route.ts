import { env } from "cloudflare:workers";
import { ensureRunStore, getD1, type D1Database } from "@/db";
import { approvalPolicy, approvalState, type ApprovalDecision } from "@/lib/auth/approvals";
import { can, configuredAdmins, resolveRole } from "@/lib/auth/roles";
import { capabilityFingerprint, sanitizeCapabilityForStorage, type ArtifactReview } from "@/lib/persistence/contracts";

export const dynamic = "force-dynamic";

function subjectId(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-id");
  if (authenticated) return authenticated;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

function adminIds() {
  const worker = env as unknown as { AUTOMATION_ADMIN_USER_IDS?: string };
  return configuredAdmins(worker.AUTOMATION_ADMIN_USER_IDS ?? process.env.AUTOMATION_ADMIN_USER_IDS);
}

type ReviewRow = {
  id: string; submitted_by: string; artifact_name: string; artifact_version: string; risk_class: ArtifactReview["riskClass"];
  required_approvals: number; state: ArtifactReview["state"]; created_at: string; reviewed_at: string | null;
  approvals: number; rejections: number;
};

function toReview(row: ReviewRow, actor: string, mayReview: boolean): ArtifactReview {
  const separationRequired = row.required_approvals > 1;
  return {
    artifactHash: row.id, artifactName: row.artifact_name, artifactVersion: row.artifact_version, state: row.state,
    operatorRole: "reviewer", submittedBy: row.submitted_by, riskClass: row.risk_class,
    requiredApprovals: row.required_approvals, approvals: Number(row.approvals), rejections: Number(row.rejections),
    separationRequired, canDecide: mayReview && (!separationRequired || row.submitted_by !== actor),
    createdAt: row.created_at, reviewedAt: row.reviewed_at,
  };
}

const REVIEW_SELECT = `SELECT r.id, r.submitted_by, r.artifact_name, r.artifact_version, r.risk_class, r.required_approvals,
  r.state, r.created_at, r.reviewed_at,
  SUM(CASE WHEN d.decision = 'approve' THEN 1 ELSE 0 END) AS approvals,
  SUM(CASE WHEN d.decision = 'reject' THEN 1 ELSE 0 END) AS rejections
  FROM approval_requests r LEFT JOIN approval_decisions d ON d.request_id = r.id`;

async function readReview(database: D1Database, artifactHash: string) {
  const response = await database.prepare(`${REVIEW_SELECT} WHERE r.id = ? GROUP BY r.id`).bind(artifactHash).all<ReviewRow>();
  return response.results?.[0];
}

async function ensureRequest(database: D1Database, actor: string, value: unknown) {
  const artifact = sanitizeCapabilityForStorage(value);
  const artifactHash = await capabilityFingerprint(artifact);
  const policy = approvalPolicy(artifact);
  const now = new Date().toISOString();
  await database.prepare(`INSERT OR IGNORE INTO approval_requests
    (id, submitted_by, artifact_name, artifact_version, artifact_json, risk_class, required_approvals, state, created_at, updated_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL)`)
    .bind(artifactHash, actor, artifact.name, artifact.version, JSON.stringify(artifact), policy.riskClass, policy.requiredApprovals, now, now).run();
  return artifactHash;
}

export async function POST(request: Request) {
  const actor = subjectId(request);
  if (!actor) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const body = await request.json() as { artifact?: unknown };
    const database = getD1();
    await ensureRunStore(database);
    const role = await resolveRole(database, actor, adminIds());
    if (!can(role, "submit_artifacts")) return Response.json({ error: "forbidden" }, { status: 403 });
    const artifactHash = await ensureRequest(database, actor, body.artifact);
    const review = await readReview(database, artifactHash);
    return Response.json({ review: toReview(review!, actor, can(role, "review_artifacts")) });
  } catch {
    return Response.json({ error: "invalid_artifact" }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const actor = subjectId(request);
  if (!actor) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const body = await request.json() as { artifact?: unknown; artifactHash?: string; decision?: ApprovalDecision };
    const database = getD1();
    await ensureRunStore(database);
    const role = await resolveRole(database, actor, adminIds());
    if (!can(role, "review_artifacts")) return Response.json({ error: "forbidden" }, { status: 403 });
    const artifactHash = body.artifact ? await ensureRequest(database, actor, body.artifact) : body.artifactHash;
    if (!artifactHash) return Response.json({ error: "review_not_found" }, { status: 404 });
    const current = await readReview(database, artifactHash);
    if (!current) return Response.json({ error: "review_not_found" }, { status: 404 });
    if (current.required_approvals > 1 && current.submitted_by === actor) return Response.json({ error: "separation_of_duties" }, { status: 409 });
    const decision = body.decision ?? "approve";
    if (!(["approve", "reject"] as const).includes(decision)) return Response.json({ error: "invalid_decision" }, { status: 400 });
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO approval_decisions (id, request_id, reviewer_id, decision, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`)
      .bind(`${artifactHash}:${actor}`, artifactHash, actor, decision, now).run();
    const counted = await readReview(database, artifactHash);
    const state = approvalState(Number(counted!.approvals), Number(counted!.rejections), counted!.required_approvals);
    const reviewedAt = ["approved", "rejected"].includes(state) ? now : null;
    await database.prepare("UPDATE approval_requests SET state = ?, updated_at = ?, reviewed_at = ? WHERE id = ?").bind(state, now, reviewedAt, artifactHash).run();
    const updated = await readReview(database, artifactHash);
    return Response.json({ review: toReview(updated!, actor, true) });
  } catch {
    return Response.json({ error: "review_failed" }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const actor = subjectId(request);
  if (!actor) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const database = getD1();
    await ensureRunStore(database);
    const role = await resolveRole(database, actor, adminIds());
    const mayReview = can(role, "review_artifacts");
    const query = `${REVIEW_SELECT}${mayReview ? "" : " WHERE r.submitted_by = ?"} GROUP BY r.id ORDER BY r.created_at DESC LIMIT 50`;
    const statement = database.prepare(query);
    const response = mayReview ? await statement.all<ReviewRow>() : await statement.bind(actor).all<ReviewRow>();
    return Response.json({ reviews: (response.results ?? []).map((row) => toReview(row, actor, mayReview)), operatorRole: role });
  } catch {
    return Response.json({ error: "storage_unavailable" }, { status: 503 });
  }
}
