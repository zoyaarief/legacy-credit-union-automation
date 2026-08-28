import { env } from "cloudflare:workers";
import { ensureRunStore, getD1 } from "@/db";
import { summarizeOperations } from "@/lib/operations/core";
import { recordOperationalEvent } from "@/lib/operations/store";
import { decryptEvidence, encryptEvidence } from "@/lib/security/evidence";

export const dynamic = "force-dynamic";

function ownerId(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-id");
  if (authenticated) return authenticated;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

function keyring() {
  const workerEnv = env as unknown as {
    EVIDENCE_ENCRYPTION_KEY?: string; EVIDENCE_KEY_VERSION?: string;
    EVIDENCE_PREVIOUS_ENCRYPTION_KEY?: string; EVIDENCE_PREVIOUS_KEY_VERSION?: string;
  };
  return {
    currentSecret: workerEnv.EVIDENCE_ENCRYPTION_KEY ?? process.env.EVIDENCE_ENCRYPTION_KEY,
    currentVersion: workerEnv.EVIDENCE_KEY_VERSION ?? process.env.EVIDENCE_KEY_VERSION ?? "v1",
    previousSecret: workerEnv.EVIDENCE_PREVIOUS_ENCRYPTION_KEY ?? process.env.EVIDENCE_PREVIOUS_ENCRYPTION_KEY,
    previousVersion: workerEnv.EVIDENCE_PREVIOUS_KEY_VERSION ?? process.env.EVIDENCE_PREVIOUS_KEY_VERSION,
  };
}

type EventRow = { event_type: string };
type SummaryRow = { status: string; summary_json: string };
type CountRow = { count: number };
type RotationRow = { id: string; evidence_hash: string; evidence_ciphertext: string; evidence_iv: string; evidence_key_version: string };
type JobStatusRow = { status: string };

export async function GET(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const database = getD1();
    await ensureRunStore(database);
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    const keys = keyring();
    const [events, runs, stale, jobs] = await Promise.all([
      database.prepare("SELECT event_type FROM operational_events WHERE owner_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500").bind(owner, cutoff).all<EventRow>(),
      database.prepare("SELECT status, summary_json FROM automation_runs WHERE owner_id = ? AND run_kind = 'agent_invocation' AND created_at >= ? ORDER BY created_at DESC LIMIT 200").bind(owner, cutoff).all<SummaryRow>(),
      database.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE owner_id = ? AND evidence_ciphertext IS NOT NULL AND evidence_key_version != ?").bind(owner, keys.currentVersion).all<CountRow>(),
      database.prepare("SELECT status FROM automation_jobs WHERE owner_id = ? AND status IN ('queued', 'human_required') LIMIT 200").bind(owner).all<JobStatusRow>(),
    ]);
    const runSummaries = (runs.results ?? []).map((row) => {
      const summary = JSON.parse(row.summary_json) as { recovered?: boolean };
      return { status: row.status, recovered: Boolean(summary.recovered) };
    });
    return Response.json({ snapshot: summarizeOperations({
      eventTypes: (events.results ?? []).map((row) => row.event_type), runSummaries,
      currentKeyVersion: keys.currentVersion, staleEvidenceRows: Number(stale.results?.[0]?.count ?? 0),
      previousKeyConfigured: Boolean(keys.previousSecret && keys.previousVersion),
      jobStatuses: (jobs.results ?? []).map((row) => row.status),
    }) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "operations_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "content_type_required" }, { status: 415 });
  try {
    const body = await request.json() as { action?: string };
    if (body.action !== "rotate_evidence") return Response.json({ error: "unsupported_action" }, { status: 400 });
    const database = getD1();
    await ensureRunStore(database);
    const keys = keyring();
    if (!keys.currentSecret) return Response.json({ error: "encryption_unavailable" }, { status: 503 });
    const response = await database.prepare(`SELECT id, evidence_hash, evidence_ciphertext, evidence_iv, evidence_key_version
      FROM automation_runs WHERE owner_id = ? AND evidence_ciphertext IS NOT NULL AND evidence_key_version != ? LIMIT 50`)
      .bind(owner, keys.currentVersion).all<RotationRow>();
    const rows = response.results ?? [];
    if (rows.length === 0) return Response.json({ rotated: 0, keyVersion: keys.currentVersion });
    if (!keys.previousSecret || !keys.previousVersion) return Response.json({ error: "previous_key_not_configured", pending: rows.length }, { status: 409 });
    if (rows.some((row) => row.evidence_key_version !== keys.previousVersion)) return Response.json({ error: "unsupported_key_version" }, { status: 409 });
    const updates = await Promise.all(rows.map(async (row) => {
      const context = `${owner}:${row.id}:${row.evidence_hash}`;
      const evidence = await decryptEvidence({ ciphertext: row.evidence_ciphertext, iv: row.evidence_iv, keyVersion: row.evidence_key_version }, keys.previousSecret!, context);
      const encrypted = await encryptEvidence(evidence, keys.currentSecret!, context, keys.currentVersion);
      return database.prepare("UPDATE automation_runs SET evidence_ciphertext = ?, evidence_iv = ?, evidence_key_version = ? WHERE id = ? AND owner_id = ?")
        .bind(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, row.id, owner);
    }));
    await database.batch(updates);
    await recordOperationalEvent(database, owner, "evidence_rotated", "ok", { rotated: rows.length, keyVersion: keys.currentVersion });
    return Response.json({ rotated: rows.length, keyVersion: keys.currentVersion });
  } catch {
    return Response.json({ error: "rotation_failed" }, { status: 500 });
  }
}
