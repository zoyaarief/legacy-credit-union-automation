import { env } from "cloudflare:workers";
import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import { ensureRunStore, getD1, type D1Database } from "@/db";
import { AutomationError } from "@/lib/automation/core";
import { listCapabilityCatalog, resolveCapabilityVariant, validateInvocationInputs, type InvocationTicket, type VerifiedInvocation } from "@/lib/automation/catalog";
import { capabilityFingerprint } from "@/lib/persistence/contracts";
import { consumeInvocationQuota, recordOperationalEvent } from "@/lib/operations/store";
import { signInvocation, verifyInvocation, type InvocationSignatureClaims } from "@/lib/security/invocation";

export const dynamic = "force-dynamic";
const TICKET_TTL_MS = 120_000;

function ownerId(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-id");
  if (authenticated) return authenticated;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

function signingSecret() {
  const workerEnv = env as unknown as { INVOCATION_SIGNING_KEY?: string };
  return workerEnv.INVOCATION_SIGNING_KEY ?? process.env.INVOCATION_SIGNING_KEY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ticketClaims(ticket: InvocationTicket): InvocationSignatureClaims {
  return {
    invocationId: ticket.invocationId,
    artifactHash: ticket.artifactHash,
    capabilityName: ticket.capabilityName,
    capabilityVersion: ticket.capabilityVersion,
    variantId: ticket.variant.id,
    inputs: ticket.inputs,
    issuedAt: ticket.issuedAt,
    expiresAt: ticket.expiresAt,
  };
}

function parseTicket(value: unknown): InvocationTicket {
  if (!isRecord(value) || !isRecord(value.variant) || !isRecord(value.inputs)) throw new AutomationError("ticket_invalid", "invalid_request", "Invocation ticket is malformed.");
  for (const field of ["invocationId", "artifactHash", "capabilityName", "capabilityVersion", "issuedAt", "expiresAt", "signature"] as const) {
    if (typeof value[field] !== "string") throw new AutomationError("ticket_invalid", "invalid_request", `Ticket field ${field} is invalid.`);
  }
  if (typeof value.variant.id !== "string") throw new AutomationError("ticket_invalid", "invalid_request", "Ticket variant is invalid.");
  return value as unknown as InvocationTicket;
}

async function safeEvent(database: D1Database | null, owner: string, type: Parameters<typeof recordOperationalEvent>[2], outcome: Parameters<typeof recordOperationalEvent>[3], metadata: Record<string, unknown>, startedAt: number) {
  if (!database) return;
  try { await recordOperationalEvent(database, owner, type, outcome, metadata, Date.now() - startedAt); } catch { /* Telemetry never changes the contract result. */ }
}

export async function GET(request: Request) {
  if (!ownerId(request)) return Response.json({ error: "authentication_required" }, { status: 401 });
  return Response.json({
    catalogVersion: "2026-08-28",
    entries: listCapabilityCatalog(rawCapability),
    invocation: { issue: { method: "POST", path: "/api/capabilities" }, verify: { method: "PUT", path: "/api/capabilities" }, execution: "deterministic_browser_session", ticketTtlSeconds: TICKET_TTL_MS / 1000 },
  });
}

export async function POST(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "content_type_required" }, { status: 415 });
  const startedAt = Date.now();
  let database: D1Database | null = null;
  try {
    const secret = signingSecret();
    if (!secret) return Response.json({ error: "signing_unavailable" }, { status: 503 });
    const body = await request.json() as { capabilityName?: string; version?: string; variantId?: string; inputs?: unknown };
    database = getD1();
    await ensureRunStore(database);
    const quota = await consumeInvocationQuota(database, owner, startedAt);
    if (!quota.allowed) {
      await safeEvent(database, owner, "ticket_rate_limited", "rejected", { limit: quota.limit }, startedAt);
      return Response.json({ error: "rate_limited", limit: quota.limit, resetAt: quota.resetAt }, { status: 429, headers: { "Retry-After": "60", "X-RateLimit-Limit": String(quota.limit), "X-RateLimit-Remaining": "0" } });
    }
    if (body.capabilityName !== rawCapability.name || body.version !== rawCapability.version || typeof body.variantId !== "string") {
      await safeEvent(database, owner, "ticket_rejected", "rejected", { reason: "capability_not_found" }, startedAt);
      return Response.json({ error: "capability_not_found" }, { status: 404 });
    }
    const { artifact, variant } = resolveCapabilityVariant(rawCapability, body.variantId);
    const inputs = validateInvocationInputs(artifact, body.inputs);
    const issuedAt = new Date(startedAt).toISOString();
    const expiresAt = new Date(startedAt + TICKET_TTL_MS).toISOString();
    const unsigned = {
      invocationId: crypto.randomUUID(), artifactHash: await capabilityFingerprint(artifact), capabilityName: artifact.name,
      capabilityVersion: artifact.version, variant, inputs, issuedAt, expiresAt,
    };
    const signature = await signInvocation(owner, {
      invocationId: unsigned.invocationId, artifactHash: unsigned.artifactHash, capabilityName: unsigned.capabilityName,
      capabilityVersion: unsigned.capabilityVersion, variantId: variant.id, inputs, issuedAt, expiresAt,
    }, secret);
    const ticket: InvocationTicket = { ...unsigned, signature };
    await safeEvent(database, owner, "ticket_issued", "ok", { variantId: variant.id, capabilityName: artifact.name }, startedAt);
    return Response.json({ ticket }, { status: 201, headers: { "Cache-Control": "no-store", "X-RateLimit-Limit": String(quota.limit), "X-RateLimit-Remaining": String(quota.remaining) } });
  } catch (error) {
    await safeEvent(database, owner, "ticket_rejected", "rejected", { reason: error instanceof AutomationError ? error.code : "invalid_request" }, startedAt);
    if (error instanceof AutomationError) return Response.json({ error: error.code, message: error.message }, { status: 400 });
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  const owner = ownerId(request);
  if (!owner) return Response.json({ error: "authentication_required" }, { status: 401 });
  if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "content_type_required" }, { status: 415 });
  const startedAt = Date.now();
  let database: D1Database | null = null;
  try {
    const secret = signingSecret();
    if (!secret) return Response.json({ error: "signing_unavailable" }, { status: 503 });
    const body = await request.json() as { ticket?: unknown };
    const ticket = parseTicket(body.ticket);
    database = getD1();
    await ensureRunStore(database);
    const verified = await verifyInvocation({ ownerId: owner, claims: ticketClaims(ticket), signature: ticket.signature, secret });
    if (!verified.valid) {
      await safeEvent(database, owner, "ticket_rejected", "rejected", { reason: verified.reason }, startedAt);
      return Response.json({ error: verified.reason }, { status: verified.reason === "expired" ? 410 : 401 });
    }
    if (ticket.capabilityName !== rawCapability.name || ticket.capabilityVersion !== rawCapability.version) throw new AutomationError("ticket_invalid", "invalid_request", "Ticket capability is unavailable.");
    const { artifact, variant } = resolveCapabilityVariant(rawCapability, ticket.variant.id);
    if (await capabilityFingerprint(artifact) !== ticket.artifactHash) throw new AutomationError("ticket_integrity_failed", "policy_denied", "Ticket artifact fingerprint is invalid.");
    const inputs = validateInvocationInputs(artifact, ticket.inputs);
    const invocation: VerifiedInvocation = { ...ticket, variant, inputs, artifact };
    await safeEvent(database, owner, "ticket_verified", "ok", { variantId: variant.id, capabilityName: artifact.name }, startedAt);
    return Response.json({ verified: true, invocation }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await safeEvent(database, owner, "ticket_rejected", "rejected", { reason: error instanceof AutomationError ? error.code : "invalid_request" }, startedAt);
    if (error instanceof AutomationError) return Response.json({ error: error.code, message: error.message }, { status: error.category === "policy_denied" ? 401 : 400 });
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
}
