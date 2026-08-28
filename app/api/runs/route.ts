import { ensureRunStore, getD1 } from "@/db";
import { sanitizeRunRecord } from "@/lib/persistence/contracts";

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
    await database.prepare(`INSERT OR REPLACE INTO automation_runs (
      id, owner_id, run_kind, status, artifact_name, artifact_version, provider,
      summary_json, evidence_json, artifact_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.runId, owner, record.kind, record.status, record.artifactName,
        record.artifactVersion, record.provider ?? null, JSON.stringify(record.summary),
        JSON.stringify(record.evidence), record.artifact ? JSON.stringify(record.artifact) : null, createdAt,
      )
      .run();
    return Response.json({ stored: true, createdAt });
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
};

export async function GET(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const database = getD1();
    await ensureRunStore(database);
    const response = await database
      .prepare(`SELECT id, run_kind, status, artifact_name, artifact_version, provider,
        summary_json, evidence_json, artifact_json, created_at
        FROM automation_runs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(owner)
      .all<RunRow>();
    const runs = (response.results ?? []).map((row) => ({
      runId: row.id, kind: row.run_kind, status: row.status, artifactName: row.artifact_name,
      artifactVersion: row.artifact_version, provider: row.provider, summary: JSON.parse(row.summary_json),
      evidence: JSON.parse(row.evidence_json), artifact: row.artifact_json ? JSON.parse(row.artifact_json) : null,
      createdAt: row.created_at,
    }));
    return Response.json({ runs });
  } catch {
    return unavailable();
  }
}
