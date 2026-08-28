import { ensureRunStore, getD1 } from "@/db";
import { env } from "cloudflare:workers";
import { can, configuredAdmins, resolveRole } from "@/lib/auth/roles";
import { capabilityFingerprint, sanitizeCapabilityForStorage, type ArtifactReview } from "@/lib/persistence/contracts";

export const dynamic = "force-dynamic";

function ownerId(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-id");
  if (authenticated) return authenticated;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

type ReviewRow = {
  artifact_hash: string; artifact_name: string; artifact_version: string; state: string; created_at: string; reviewed_at: string | null;
};

function toReview(row: ReviewRow): ArtifactReview {
  return {
    artifactHash: row.artifact_hash,
    artifactName: row.artifact_name,
    artifactVersion: row.artifact_version,
    state: row.state === "approved" ? "approved" : "draft",
    operatorRole: "reviewer",
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

async function upsert(request: Request, approve: boolean) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const body = await request.json() as { artifact?: unknown };
    const artifact = sanitizeCapabilityForStorage(body.artifact);
    const artifactHash = await capabilityFingerprint(artifact);
    const database = getD1();
    await ensureRunStore(database);
    if (approve) {
      const worker = env as unknown as { AUTOMATION_ADMIN_USER_IDS?: string };
      const role = await resolveRole(database, owner, configuredAdmins(worker.AUTOMATION_ADMIN_USER_IDS ?? process.env.AUTOMATION_ADMIN_USER_IDS));
      if (!can(role, "review_artifacts")) return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const id = `${owner}:${artifactHash}`;
    const existing = await database.prepare("SELECT artifact_hash, artifact_name, artifact_version, state, created_at, reviewed_at FROM artifact_reviews WHERE id = ? AND owner_id = ?").bind(id, owner).all<ReviewRow>();
    const current = existing.results?.[0];
    const createdAt = current?.created_at ?? new Date().toISOString();
    const state = approve || current?.state === "approved" ? "approved" : "draft";
    const reviewedAt = state === "approved" ? current?.reviewed_at ?? new Date().toISOString() : null;
    await database.prepare(`INSERT OR REPLACE INTO artifact_reviews (
      id, owner_id, artifact_hash, artifact_name, artifact_version, state, artifact_json, created_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, owner, artifactHash, artifact.name, artifact.version, state, JSON.stringify(artifact), createdAt, reviewedAt)
      .run();
    return Response.json({ review: toReview({ artifact_hash: artifactHash, artifact_name: artifact.name, artifact_version: artifact.version, state, created_at: createdAt, reviewed_at: reviewedAt }) });
  } catch {
    return Response.json({ error: "invalid_artifact" }, { status: 400 });
  }
}

export async function POST(request: Request) { return upsert(request, false); }
export async function PATCH(request: Request) { return upsert(request, true); }

export async function GET(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const database = getD1();
    await ensureRunStore(database);
    const response = await database.prepare("SELECT artifact_hash, artifact_name, artifact_version, state, created_at, reviewed_at FROM artifact_reviews WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50").bind(owner).all<ReviewRow>();
    return Response.json({ reviews: (response.results ?? []).map(toReview), operatorRole: "reviewer" });
  } catch {
    return Response.json({ error: "storage_unavailable" }, { status: 503 });
  }
}
