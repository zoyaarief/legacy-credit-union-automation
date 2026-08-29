import {
  validateDiscoveryDecision,
  type DecisionContext,
  type DiscoveryDecision,
} from "./core.ts";

type ResponsesApiPayload = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "controlRef", "locators", "input", "output", "businessCode", "interventionCode", "reason", "capabilityName"],
  properties: {
    action: { type: "string", enum: ["type", "click", "wait_for_change", "extract", "business_outcome", "request_human", "complete"] },
    controlRef: { type: ["string", "null"], maxLength: 80 },
    locators: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["name", "css", "button_text"] },
          value: { type: "string", maxLength: 240 },
        },
      },
    },
    input: { type: ["string", "null"], enum: ["memberId", null] },
    output: { type: ["string", "null"], enum: ["balance", "accountStatus", null] },
    businessCode: { type: ["string", "null"], enum: ["member_not_found", null] },
    interventionCode: { type: ["string", "null"], enum: ["operator_acknowledgment_required", null] },
    reason: { type: "string", maxLength: 240 },
    capabilityName: { type: ["string", "null"], maxLength: 80 },
  },
} as const;

function extractOutputText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("The model response did not contain structured output text.");
}

export async function decideWithOpenAI(options: {
  apiKey: string;
  model: string;
  context: DecisionContext;
  fetchImpl?: typeof fetch;
}): Promise<DiscoveryDecision> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      store: false,
      max_output_tokens: 400,
      instructions: [
        "You are the decision component of a read-only computer-use discovery agent.",
        "Identify controls semantically from the sanitized live control inventory; control refs are observation-local and are not preassigned workflow targets.",
        "For a control action, select the observed controlRef and exactly two ordered locators copied from that control's locatorCandidates. Never invent a locator.",
        "Choose wait_for_change with no control or locators after submitting; classify visible not-found and operator-only states explicitly.",
        "Extract only declared outputs from visible value-bearing cells and complete only after both outputs were extracted and a summary region is visible.",
        "Never request, repeat, or infer sensitive values; cell values stay local and are intentionally omitted from observations.",
        "Return a concise operational reason, not hidden reasoning or a chain-of-thought transcript.",
      ].join(" "),
      input: JSON.stringify(options.context),
      text: {
        format: {
          type: "json_schema",
          name: "computer_use_discovery_decision",
          strict: true,
          schema: DECISION_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Responses request failed with status ${response.status}.`);
  }
  const payload = await response.json() as ResponsesApiPayload;
  const decision = JSON.parse(extractOutputText(payload)) as unknown;
  return validateDiscoveryDecision(decision, options.context);
}
