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
        useSimulator = true;
        return simulator.decide(context);
      }
      if (response.status === 503) {
        useSimulator = true;
        return simulator.decide(context);
      }
      const payload = await response.json() as ProviderResponse;
      if (!response.ok || !("decision" in payload)) {
        throw new Error("The live discovery model could not produce a decision.");
      }
      return payload;
    },
  };
}
