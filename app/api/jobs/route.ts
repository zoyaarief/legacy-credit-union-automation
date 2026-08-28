import { env } from "cloudflare:workers";
import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import { ensureRunStore, getD1 } from "@/db";
import { resolveCapabilityVariant, validateInvocationInputs, type InvocationTicket } from "@/lib/automation/catalog";
import type { AutomationJob, JobStatus } from "@/lib/jobs/core";
import { consumeInvocationQuota, recordOperationalEvent } from "@/lib/operations/store";
import { capabilityFingerprint } from "@/lib/persistence/contracts";
import { decryptEvidence, encryptEvidence } from "@/lib/security/evidence";
import { signInvocation } from "@/lib/security/invocation";

export const dynamic = "force-dynamic";
const LEASE_MS = 180_000;
const TICKET_TTL_MS = 120_000;

function ownerId(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (owner) return owner;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

function secrets() {
  const worker = env as unknown as {
    EVIDENCE_ENCRYPTION_KEY?: string; EVIDENCE_KEY_VERSION?: string; EVIDENCE_PREVIOUS_ENCRYPTION_KEY?: string; EVIDENCE_PREVIOUS_KEY_VERSION?: string; INVOCATION_SIGNING_KEY?: string;
  };
  return {
    current: worker.EVIDENCE_ENCRYPTION_KEY ?? process.env.EVIDENCE_ENCRYPTION_KEY,
    currentVersion: worker.EVIDENCE_KEY_VERSION ?? process.env.EVIDENCE_KEY_VERSION ?? "v1",
    previous: worker.EVIDENCE_PREVIOUS_ENCRYPTION_KEY ?? process.env.EVIDENCE_PREVIOUS_ENCRYPTION_KEY,
    previousVersion: worker.EVIDENCE_PREVIOUS_KEY_VERSION ?? process.env.EVIDENCE_PREVIOUS_KEY_VERSION,
    signing: worker.INVOCATION_SIGNING_KEY ?? process.env.INVOCATION_SIGNING_KEY,
  };
}

type JobRow = {
  id: string; status: JobStatus; capability_name: string; capability_version: string; variant_id: string; artifact_hash: string;
  input_ciphertext: string; input_iv: string; input_key_version: string; result_json: string | null;
  created_at: string; updated_at: string; claimed_at: string | null; lease_expires_at: string | null; completed_at: string | null;
};

function publicJob(row: JobRow): AutomationJob {
  return { jobId: row.id, status: row.status, capabilityName: row.capability_name, capabilityVersion: row.capability_version, variantId: row.variant_id,
    artifactHash: row.artifact_hash, result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at,
    claimedAt: row.claimed_at, leaseExpiresAt: row.lease_expires_at, completedAt: row.completed_at };
}

async function findJob(owner: string, jobId: string) {
  const database = getD1();
  await ensureRunStore(database);
  const response = await database.prepare(`SELECT id, status, capability_name, capability_version, variant_id, artifact_hash,
    input_ciphertext, input_iv, input_key_version, result_json, created_at, updated_at, claimed_at, lease_expires_at, completed_at
    FROM automation_jobs WHERE id = ? AND owner_id = ?`).bind(jobId, owner).all<JobRow>();
  return { database, row: response.results?.[0] };
}

export async function GET(request: Request) {
  const owner = ownerId(request); if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const database = getD1(); await ensureRunStore(database);
    const response = await database.prepare(`SELECT id, status, capability_name, capability_version, variant_id, artifact_hash,
      input_ciphertext, input_iv, input_key_version, result_json, created_at, updated_at, claimed_at, lease_expires_at, completed_at
      FROM automation_jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 30`).bind(owner).all<JobRow>();
    return Response.json({ jobs: (response.results ?? []).map(publicJob) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "jobs_unavailable" }, { status: 503 }); }
}

export async function POST(request: Request) {
  const owner = ownerId(request); if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const config = secrets(); if (!config.current) return Response.json({ error: "encryption_unavailable" }, { status: 503 });
    const body = await request.json() as { capabilityName?: string; version?: string; variantId?: string; inputs?: unknown };
    if (body.capabilityName !== rawCapability.name || body.version !== rawCapability.version || typeof body.variantId !== "string") return Response.json({ error: "capability_not_found" }, { status: 404 });
    const { artifact, variant } = resolveCapabilityVariant(rawCapability, body.variantId);
    const inputs = validateInvocationInputs(artifact, body.inputs);
    const database = getD1(); await ensureRunStore(database);
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    const encrypted = await encryptEvidence(inputs, config.current, `${owner}:job:${id}:inputs`, config.currentVersion);
    const hash = await capabilityFingerprint(artifact);
    await database.prepare(`INSERT INTO automation_jobs (id, owner_id, status, capability_name, capability_version, variant_id, artifact_hash,
      input_ciphertext, input_iv, input_key_version, result_json, created_at, updated_at, claimed_at, lease_expires_at, completed_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`)
      .bind(id, owner, artifact.name, artifact.version, variant.id, hash, encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, now, now).run();
    await recordOperationalEvent(database, owner, "job_queued", "ok", { variantId: variant.id });
    const { row } = await findJob(owner, id);
    return Response.json({ job: publicJob(row!) }, { status: 201 });
  } catch { return Response.json({ error: "invalid_job" }, { status: 400 }); }
}

export async function PATCH(request: Request) {
  const owner = ownerId(request); if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  try {
    const body = await request.json() as { action?: string; jobId?: string; status?: JobStatus; result?: Record<string, unknown> };
    if (typeof body.jobId !== "string") return Response.json({ error: "invalid_job_id" }, { status: 400 });
    const { database, row } = await findJob(owner, body.jobId); if (!row) return Response.json({ error: "job_not_found" }, { status: 404 });
    await ensureRunStore(database);
    if (body.action === "complete") {
      const allowed: JobStatus[] = ["success", "business_outcome", "human_required", "failure"];
      if (!body.status || !allowed.includes(body.status)) return Response.json({ error: "invalid_status" }, { status: 400 });
      const now = new Date().toISOString(); const completed = body.status === "human_required" ? null : now;
      await database.prepare("UPDATE automation_jobs SET status = ?, result_json = ?, updated_at = ?, completed_at = ?, lease_expires_at = NULL WHERE id = ? AND owner_id = ?")
        .bind(body.status, JSON.stringify(body.result ?? {}), now, completed, row.id, owner).run();
      await recordOperationalEvent(database, owner, "job_completed", "ok", { status: body.status });
      const updated = await findJob(owner, row.id); return Response.json({ job: publicJob(updated.row!) });
    }
    if (body.action !== "claim") return Response.json({ error: "unsupported_action" }, { status: 400 });
    const nowMs = Date.now();
    if (!["queued", "human_required"].includes(row.status) && !(row.status === "running" && Date.parse(row.lease_expires_at ?? "") <= nowMs)) return Response.json({ error: "job_not_claimable" }, { status: 409 });
    const config = secrets(); if (!config.signing) return Response.json({ error: "signing_unavailable" }, { status: 503 });
    const inputSecret = row.input_key_version === config.currentVersion ? config.current : row.input_key_version === config.previousVersion ? config.previous : undefined;
    if (!inputSecret) return Response.json({ error: "job_key_unavailable" }, { status: 503 });
    const quota = await consumeInvocationQuota(database, owner, nowMs); if (!quota.allowed) return Response.json({ error: "rate_limited", resetAt: quota.resetAt }, { status: 429 });
    const inputs = await decryptEvidence({ ciphertext: row.input_ciphertext, iv: row.input_iv, keyVersion: row.input_key_version }, inputSecret, `${owner}:job:${row.id}:inputs`) as Record<string, string>;
    const { artifact, variant } = resolveCapabilityVariant(rawCapability, row.variant_id);
    if (await capabilityFingerprint(artifact) !== row.artifact_hash) return Response.json({ error: "job_integrity_failed" }, { status: 409 });
    const issuedAt = new Date(nowMs).toISOString(); const expiresAt = new Date(nowMs + TICKET_TTL_MS).toISOString();
    const unsigned = { invocationId: crypto.randomUUID(), artifactHash: row.artifact_hash, capabilityName: artifact.name, capabilityVersion: artifact.version, variant, inputs, issuedAt, expiresAt };
    const signature = await signInvocation(owner, { invocationId: unsigned.invocationId, artifactHash: unsigned.artifactHash, capabilityName: artifact.name, capabilityVersion: artifact.version, variantId: variant.id, inputs, issuedAt, expiresAt }, config.signing);
    const ticket: InvocationTicket = { ...unsigned, signature };
    const leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString();
    await database.prepare("UPDATE automation_jobs SET status = 'running', claimed_at = ?, updated_at = ?, lease_expires_at = ? WHERE id = ? AND owner_id = ?")
      .bind(issuedAt, issuedAt, leaseExpiresAt, row.id, owner).run();
    await recordOperationalEvent(database, owner, "job_claimed", "ok", { variantId: variant.id });
    await recordOperationalEvent(database, owner, "ticket_issued", "ok", { source: "job", variantId: variant.id });
    return Response.json({ ticket, leaseExpiresAt });
  } catch { return Response.json({ error: "job_action_failed" }, { status: 400 }); }
}

export async function DELETE(request: Request) {
  const owner = ownerId(request); if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  const jobId = new URL(request.url).searchParams.get("jobId"); if (!jobId) return Response.json({ error: "invalid_job_id" }, { status: 400 });
  try { const database = getD1(); await ensureRunStore(database); await database.prepare("UPDATE automation_jobs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND owner_id = ? AND status IN ('queued','human_required')").bind(new Date().toISOString(), new Date().toISOString(), jobId, owner).run(); return Response.json({ cancelled: true }); }
  catch { return Response.json({ error: "cancel_failed" }, { status: 503 }); }
}
