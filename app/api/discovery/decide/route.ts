import { env } from "cloudflare:workers";
import { decideWithOpenAI } from "@/lib/discovery/openai";
import type { DecisionContext } from "@/lib/discovery/core";

type DiscoveryEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_DISCOVERY_MODEL?: string;
  DISCOVERY_FORCE_SIMULATOR?: string;
};

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const isLocalRequest = ["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json({ error: "content_type_required" }, { status: 415 });
  }
  const body = await request.json().catch(() => null) as { context?: DecisionContext } | null;
  if (!body?.context) return Response.json({ error: "invalid_request" }, { status: 400 });

  const workerEnv = env as unknown as DiscoveryEnv;
  const forceSimulator = workerEnv.DISCOVERY_FORCE_SIMULATOR === "1" || process.env.DISCOVERY_FORCE_SIMULATOR === "1";
  const apiKey = workerEnv.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (forceSimulator || !apiKey || !isLocalRequest) {
    return Response.json({ error: "provider_unavailable", fallback: "safe-simulator" }, { status: 503 });
  }
  const model = workerEnv.OPENAI_DISCOVERY_MODEL ?? process.env.OPENAI_DISCOVERY_MODEL ?? "gpt-5.4-mini";
  try {
    const decision = await decideWithOpenAI({ apiKey, model, context: body.context, signal: request.signal });
    return Response.json({ provider: `openai:${model}`, decision });
  } catch {
    return Response.json({ error: "model_request_failed" }, { status: 502 });
  }
}
