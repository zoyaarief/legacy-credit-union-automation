import {
  createSimulatedDiscoveryProvider,
  type DecisionContext,
  type DiscoveryProvider,
  type ProviderDecision,
} from "./core.ts";

type ProviderResponse = ProviderDecision | { error: string };

export function createAdaptiveDiscoveryProvider(fetchImpl: typeof fetch = fetch): DiscoveryProvider {
  const simulator = createSimulatedDiscoveryProvider();
  let useSimulator = false;

  return {
    async decide(context: DecisionContext) {
      if (useSimulator) return simulator.decide(context);
      let response: Response;
      try {
        response = await fetchImpl("/api/discovery/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context }),
        });
      } catch {
        throw new Error("The live discovery provider could not be reached.");
      }
      if (response.status === 503) {
        const unavailable = await response.json().catch(() => null) as { error?: string; fallback?: string } | null;
        if (unavailable?.error === "provider_unavailable" && unavailable.fallback === "safe-simulator") {
          useSimulator = true;
          return simulator.decide(context);
        }
        throw new Error("The live discovery provider is unavailable.");
      }
      const payload = await response.json() as ProviderResponse;
      if (!response.ok || !("decision" in payload)) {
        throw new Error("The live discovery model could not produce a decision.");
      }
      return payload;
    },
  };
}
