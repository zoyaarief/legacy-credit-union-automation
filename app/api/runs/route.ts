import { ensureRunStore, getD1 } from "@/db";
import { sanitizeRunRecord, sha256 } from "@/lib/persistence/contracts";

export const dynamic = "force-dynamic";

function ownerId(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-id");
  if (authenticated) return authenticated;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

function unavailable() {
  return Response.json({ error: "storage_unavailable" }, { status: 503 });
}

export async function POST(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const record = sanitizeRunRecord(await request.json());
    const database = getD1();
    await ensureRunStore(database);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (record.retentionDays ?? 30) * 86_400_000).toISOString();
    const evidenceHash = await sha256(record.evidence);
    await database.prepare(`INSERT OR REPLACE INTO automation_runs (
      id, owner_id, run_kind, status, artifact_name, artifact_version, provider,
      summary_json, evidence_json, artifact_json, evidence_hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.runId, owner, record.kind, record.status, record.artifactName,
        record.artifactVersion, record.provider ?? null, JSON.stringify(record.summary),
        JSON.stringify(record.evidence), record.artifact ? JSON.stringify(record.artifact) : null,
        evidenceHash, createdAt, expiresAt,
      )
      .run();
    return Response.json({ stored: true, createdAt, expiresAt, evidenceHash });
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /invalid|required|must/i.test(error.message))) {
      return Response.json({ error: "invalid_run_record" }, { status: 400 });
    }
    return unavailable();
  }
}

type RunRow = {
  id: string; run_kind: string; status: string; artifact_name: string; artifact_version: string;
  provider: string | null; summary_json: string; evidence_json: string; artifact_json: string | null; created_at: string;
  evidence_hash: string; expires_at: string;
};

export async function GET(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const database = getD1();
    await ensureRunStore(database);
    await database.prepare("DELETE FROM automation_runs WHERE owner_id = ? AND expires_at != '' AND expires_at <= ?").bind(owner, new Date().toISOString()).run();
    const response = await database
      .prepare(`SELECT id, run_kind, status, artifact_name, artifact_version, provider,
        summary_json, evidence_json, artifact_json, evidence_hash, created_at, expires_at
        FROM automation_runs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(owner)
      .all<RunRow>();
    const runs = await Promise.all((response.results ?? []).map(async (row) => {
      const evidence = JSON.parse(row.evidence_json);
      const calculatedHash = await sha256(evidence);
      return {
        runId: row.id, kind: row.run_kind, status: row.status, artifactName: row.artifact_name,
        artifactVersion: row.artifact_version, provider: row.provider, summary: JSON.parse(row.summary_json),
        evidence, artifact: row.artifact_json ? JSON.parse(row.artifact_json) : null,
        evidenceHash: row.evidence_hash, integrity: row.evidence_hash ? calculatedHash === row.evidence_hash ? "verified" : "mismatch" : "legacy",
        createdAt: row.created_at, expiresAt: row.expires_at,
      };
    }));
    return Response.json({ runs });
  } catch {
    return unavailable();
  }
}

export async function DELETE(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId || runId.length > 100) return Response.json({ error: "invalid_run_id" }, { status: 400 });
  try {
    const database = getD1();
    await ensureRunStore(database);
    await database.prepare("DELETE FROM automation_runs WHERE id = ? AND owner_id = ?").bind(runId, owner).run();
    return Response.json({ deleted: true });
  } catch {
    return unavailable();
  }
}
