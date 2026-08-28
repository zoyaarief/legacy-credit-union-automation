import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import { AutomationError } from "@/lib/automation/core";
import { listCapabilityCatalog, resolveCapabilityVariant, validateInvocationInputs, type InvocationTicket } from "@/lib/automation/catalog";
import { capabilityFingerprint } from "@/lib/persistence/contracts";

export const dynamic = "force-dynamic";

function ownerId(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-id");
  if (authenticated) return authenticated;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-demo-user" : null;
}

export async function GET(request: Request) {
  if (!ownerId(request)) return Response.json({ error: "authentication_required" }, { status: 401 });
  return Response.json({
    catalogVersion: "2026-08-28",
    entries: listCapabilityCatalog(rawCapability),
    invocation: { method: "POST", path: "/api/capabilities", execution: "deterministic_browser_session" },
  });
}

export async function POST(request: Request) {
  if (!ownerId(request)) return Response.json({ error: "authentication_required" }, { status: 401 });
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json({ error: "content_type_required" }, { status: 415 });
  }
  try {
    const body = await request.json() as { capabilityName?: string; version?: string; variantId?: string; inputs?: unknown };
    if (body.capabilityName !== rawCapability.name || body.version !== rawCapability.version || typeof body.variantId !== "string") {
      return Response.json({ error: "capability_not_found" }, { status: 404 });
    }
    const { artifact, variant } = resolveCapabilityVariant(rawCapability, body.variantId);
    const ticket: InvocationTicket = {
      invocationId: crypto.randomUUID(),
      artifactHash: await capabilityFingerprint(artifact),
      capabilityName: artifact.name,
      capabilityVersion: artifact.version,
      variant,
      artifact,
      inputs: validateInvocationInputs(artifact, body.inputs),
      issuedAt: new Date().toISOString(),
    };
    return Response.json({ ticket }, { status: 201 });
  } catch (error) {
    if (error instanceof AutomationError) return Response.json({ error: error.code, message: error.message }, { status: 400 });
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
}
