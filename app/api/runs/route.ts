import { env } from "cloudflare:workers";
import { ensureRunStore, getD1 } from "@/db";
import { sanitizeRunRecord, sha256 } from "@/lib/persistence/contracts";
import { decryptEvidence, encryptEvidence } from "@/lib/security/evidence";
import { recordOperationalEvent } from "@/lib/operations/store";

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

function isLocal(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function encryptionConfig() {
  const workerEnv = env as unknown as {
    EVIDENCE_ENCRYPTION_KEY?: string; EVIDENCE_KEY_VERSION?: string;
    EVIDENCE_PREVIOUS_ENCRYPTION_KEY?: string; EVIDENCE_PREVIOUS_KEY_VERSION?: string;
  };
  return {
    secret: workerEnv.EVIDENCE_ENCRYPTION_KEY ?? process.env.EVIDENCE_ENCRYPTION_KEY,
    keyVersion: workerEnv.EVIDENCE_KEY_VERSION ?? process.env.EVIDENCE_KEY_VERSION ?? "v1",
    previousSecret: workerEnv.EVIDENCE_PREVIOUS_ENCRYPTION_KEY ?? process.env.EVIDENCE_PREVIOUS_ENCRYPTION_KEY,
    previousKeyVersion: workerEnv.EVIDENCE_PREVIOUS_KEY_VERSION ?? process.env.EVIDENCE_PREVIOUS_KEY_VERSION,
  };
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
    const encryption = encryptionConfig();
    if (!encryption.secret && !isLocal(request)) return Response.json({ error: "encryption_unavailable" }, { status: 503 });
    const encrypted = encryption.secret
      ? await encryptEvidence(record.evidence, encryption.secret, `${owner}:${record.runId}:${evidenceHash}`, encryption.keyVersion)
      : null;
    await database.prepare(`INSERT OR REPLACE INTO automation_runs (
      id, owner_id, run_kind, status, artifact_name, artifact_version, provider,
      summary_json, evidence_json, evidence_ciphertext, evidence_iv, evidence_key_version,
      artifact_json, evidence_hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        record.runId, owner, record.kind, record.status, record.artifactName,
        record.artifactVersion, record.provider ?? null, JSON.stringify(record.summary),
        encrypted ? "[]" : JSON.stringify(record.evidence), encrypted?.ciphertext ?? null,
        encrypted?.iv ?? null, encrypted?.keyVersion ?? null, record.artifact ? JSON.stringify(record.artifact) : null,
        evidenceHash, createdAt, expiresAt,
      )
      .run();
    if (record.kind === "agent_invocation") {
      try { await recordOperationalEvent(database, owner, "agent_run_stored", "ok", { status: record.status }); } catch { /* Run storage must not depend on telemetry. */ }
    }
    return Response.json({ stored: true, createdAt, expiresAt, evidenceHash, encryption: encrypted ? "aes-gcm" : "legacy-plaintext" });
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
  evidence_ciphertext: string | null; evidence_iv: string | null; evidence_key_version: string | null;
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
        summary_json, evidence_json, evidence_ciphertext, evidence_iv, evidence_key_version,
        artifact_json, evidence_hash, created_at, expires_at
        FROM automation_runs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(owner)
      .all<RunRow>();
    const encryption = encryptionConfig();
    const runs = await Promise.all((response.results ?? []).map(async (row) => {
      const encrypted = Boolean(row.evidence_ciphertext && row.evidence_iv);
      const evidenceSecret = row.evidence_key_version === encryption.keyVersion
        ? encryption.secret
        : row.evidence_key_version === encryption.previousKeyVersion
          ? encryption.previousSecret
          : undefined;
      if (encrypted && !evidenceSecret) throw new Error("Evidence encryption key is unavailable.");
      const evidence = encrypted
        ? await decryptEvidence(
            { ciphertext: row.evidence_ciphertext!, iv: row.evidence_iv!, keyVersion: row.evidence_key_version ?? "unknown" },
            evidenceSecret!,
            `${owner}:${row.id}:${row.evidence_hash}`,
          )
        : JSON.parse(row.evidence_json);
      const calculatedHash = await sha256(evidence);
      return {
        runId: row.id, kind: row.run_kind, status: row.status, artifactName: row.artifact_name,
        artifactVersion: row.artifact_version, provider: row.provider, summary: JSON.parse(row.summary_json),
        evidence, artifact: row.artifact_json ? JSON.parse(row.artifact_json) : null,
        evidenceHash: row.evidence_hash, integrity: row.evidence_hash ? calculatedHash === row.evidence_hash ? "verified" : "mismatch" : "legacy",
        encryption: encrypted ? "aes-gcm" : "legacy-plaintext", keyVersion: row.evidence_key_version,
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
