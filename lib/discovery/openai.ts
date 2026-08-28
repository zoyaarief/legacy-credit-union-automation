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
  required: ["action", "targetId", "input", "output", "reason", "capabilityName"],
  properties: {
    action: { type: "string", enum: ["type", "click", "wait_for_outcome", "extract", "complete"] },
    targetId: {
      type: ["string", "null"],
      enum: ["member_number", "retrieve_record", "member_summary", "member_not_found", "savings_balance", "account_status", null],
    },
    input: { type: ["string", "null"], enum: ["memberId", null] },
    output: { type: ["string", "null"], enum: ["balance", "accountStatus", null] },
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
        "Choose exactly one action from the provided contract based on the current observation and prior actions.",
        "Never invent selectors, targets, inputs, outputs, or values. Never request or repeat sensitive values.",
        "Use wait_for_outcome after submitting the lookup, extract outputs only when their controls are visible, and complete only after both outputs were extracted.",
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
