import {
  AutomationError,
  isAllowedTargetUrl,
  validateCapability,
  type Capability,
  type ControlTarget,
  type OutcomeDefinition,
} from "../automation/core.ts";

export const TARGET_CATALOG = {
  member_number: {
    description: "Member Number input",
    locators: [
      { kind: "name", value: "member_number" },
      { kind: "css", value: "input[maxlength='5']" },
    ],
  },
  retrieve_record: {
    description: "Retrieve Record button",
    locators: [
      { kind: "button_text", value: "Retrieve Record" },
      { kind: "css", value: "form button[type='submit']" },
    ],
  },
  member_summary: {
    description: "Member summary panel",
    locators: [
      { kind: "css", value: "#member-summary" },
      { kind: "css", value: ".member-result" },
    ],
  },
  member_not_found: {
    description: "Member not found message",
    locators: [
      { kind: "css", value: "#not-found" },
      { kind: "css", value: ".legacy-message" },
    ],
  },
  savings_balance: {
    description: "Regular savings current balance cell",
    locators: [
      { kind: "css", value: ".accounts-grid tbody tr .savings-balance" },
      { kind: "css", value: "#member-summary .money" },
    ],
  },
  account_status: {
    description: "Regular savings status cell",
    locators: [
      { kind: "css", value: ".accounts-grid tbody tr .account-status" },
      { kind: "css", value: "#member-summary .accounts-grid td:nth-child(4)" },
    ],
  },
} as const satisfies Record<string, ControlTarget>;

export type TargetId = keyof typeof TARGET_CATALOG;
export type DiscoveryActionName = "type" | "click" | "wait_for_outcome" | "extract" | "complete";

export type ObservedControl = {
  id: TargetId;
  role: "textbox" | "button" | "region" | "status" | "text";
  name: string;
  visible: boolean;
  enabled?: boolean;
  filled?: boolean;
  hasValue?: boolean;
};

export type SurfaceObservation = {
  url: string;
  title: string;
  controls: ObservedControl[];
};

export type DiscoveryDecision = {
  action: DiscoveryActionName;
  targetId: TargetId | null;
  input: string | null;
  output: string | null;
  reason: string;
  capabilityName: string | null;
};

export type DecisionContext = {
  goal: string;
  step: number;
  maxSteps: number;
  inputContract: Record<string, { type: "string"; sensitive: boolean }>;
  outputContract: Record<string, { type: "currency" | "string" }>;
  observation: SurfaceObservation;
  history: Array<{ action: DiscoveryActionName; targetId: TargetId | null; input: string | null; output: string | null }>;
};

export type ProviderDecision = { provider: string; decision: DiscoveryDecision };
export type DiscoveryProvider = { decide(context: DecisionContext): Promise<ProviderDecision> };

export type DiscoveryAdapterResult = {
  locator?: string;
  value?: string;
  outcome?: "success" | "business_outcome";
  businessCode?: string;
};

export type DiscoveryAdapter = {
  prepare(entryPoint: string): Promise<void>;
  currentUrl(): string;
  observe(): Promise<SurfaceObservation>;
  execute(decision: DiscoveryDecision, inputs: Record<string, string>): Promise<DiscoveryAdapterResult>;
  verify(targetId: TargetId): Promise<boolean>;
};

export type DiscoveryEvidenceEvent = {
  sequence: number;
  at: string;
  phase: "policy" | "observe" | "decide" | "act" | "compile" | "complete";
  step: number;
  outcome: "ok" | "business_outcome" | "error";
  detail: string;
  provider?: string;
};

export type DiscoveryResult =
  | {
      runId: string;
      status: "success";
      provider: string;
      outputs: Record<string, string>;
      artifact: Capability;
      evidence: DiscoveryEvidenceEvent[];
    }
  | {
      runId: string;
      status: "business_outcome";
      provider: string;
      code: "member_not_found";
      message: string;
      evidence: DiscoveryEvidenceEvent[];
    }
  | {
      runId: string;
      status: "failure";
      provider: string;
      error: { code: string; message: string; step: number; retryable: boolean };
      evidence: DiscoveryEvidenceEvent[];
    };

type RecordedAction = {
  action: Exclude<DiscoveryActionName, "complete">;
  targetId: TargetId | null;
  input: string | null;
  output: string | null;
};

const DISCOVERY_POLICY_CAPABILITY: Capability = {
  schemaVersion: "1.0",
  name: "discovery_policy",
  version: "1.0.0",
  description: "Policy envelope for discovery against the Northstar member-services surface.",
  target: {
    surface: "web",
    application: "northstar-core-member-services",
    entryPoint: "/legacy",
    allowlist: { sameOrigin: true, pathPrefixes: ["/legacy"] },
  },
  inputs: { memberId: { type: "string", required: true, pattern: "^[0-9]{5}$", sensitive: true } },
  outputs: { balance: { type: "currency", currency: "USD" }, accountStatus: { type: "string" } },
  policy: {
    allowedActions: ["type", "click", "wait_for_outcome", "extract"],
    risk: "read_only",
    maxSteps: 8,
    runTimeoutMs: 20000,
    requiresHumanApproval: false,
  },
  steps: [
    { id: "policy_type", action: "type", input: "memberId", target: TARGET_CATALOG.member_number },
    { id: "policy_click", action: "click", target: TARGET_CATALOG.retrieve_record },
    {
      id: "policy_wait",
      action: "wait_for_outcome",
      timeoutMs: 5000,
      outcomes: [
        { kind: "success", target: TARGET_CATALOG.member_summary },
        { kind: "business_outcome", code: "member_not_found", target: TARGET_CATALOG.member_not_found },
      ],
    },
    { id: "policy_balance", action: "extract", output: "balance", target: TARGET_CATALOG.savings_balance },
    { id: "policy_status", action: "extract", output: "accountStatus", target: TARGET_CATALOG.account_status },
  ],
  checkpoint: { kind: "element_visible", target: TARGET_CATALOG.member_summary },
  businessOutcomes: [
    { code: "member_not_found", message: "No member matched the supplied identifier.", retryable: false },
  ],
};

const ACTION_TARGETS: Record<DiscoveryActionName, TargetId[]> = {
  type: ["member_number"],
  click: ["retrieve_record"],
  wait_for_outcome: ["member_summary"],
  extract: ["savings_balance", "account_status"],
  complete: ["member_summary"],
};

export function redactDiscoveryText(value: string): string {
  return value
    .replace(/\b\d{5,}\b/g, "[REDACTED_ID]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?:sk|api|token)[-_][A-Za-z0-9_-]{12,}/gi, "[REDACTED_SECRET]");
}

export function validateDiscoveryDecision(decision: unknown, context: DecisionContext): DiscoveryDecision {
  if (typeof decision !== "object" || decision === null) {
    throw new AutomationError("model_contract_invalid", "hard_failure", "The model returned an invalid decision object.");
  }
  const candidate = decision as Record<string, unknown>;
  if (!["type", "click", "wait_for_outcome", "extract", "complete"].includes(String(candidate.action))) {
    throw new AutomationError("model_contract_invalid", "hard_failure", "The model returned an unsupported action.");
  }
  const action = candidate.action as DiscoveryActionName;
  const targetId = candidate.targetId === null ? null : String(candidate.targetId) as TargetId;
  if (!targetId || !Object.hasOwn(TARGET_CATALOG, targetId) || !ACTION_TARGETS[action].includes(targetId)) {
    throw new AutomationError("policy_denied", "policy_denied", `Target ${String(candidate.targetId)} is not allowed for ${action}.`);
  }
  if (typeof candidate.reason !== "string" || candidate.reason.length === 0 || candidate.reason.length > 240) {
    throw new AutomationError("model_contract_invalid", "hard_failure", "The model decision needs a concise reason.");
  }
  const input = candidate.input === null ? null : String(candidate.input);
  const output = candidate.output === null ? null : String(candidate.output);
  const capabilityName = candidate.capabilityName === null ? null : String(candidate.capabilityName);
  if (action === "type" && (input !== "memberId" || !Object.hasOwn(context.inputContract, input))) {
    throw new AutomationError("policy_denied", "policy_denied", "The model referenced an undeclared input.");
  }
  if (action === "extract" && (!output || !Object.hasOwn(context.outputContract, output))) {
    throw new AutomationError("policy_denied", "policy_denied", "The model referenced an undeclared output.");
  }
  if (["type", "click", "extract", "complete"].includes(action)) {
    const visible = context.observation.controls.some((control) => control.id === targetId && control.visible);
    if (!visible) throw new AutomationError("target_not_observed", "hard_failure", `${targetId} is not visible in the current observation.`);
  }
  return { action, targetId, input, output, reason: redactDiscoveryText(candidate.reason), capabilityName };
}

function validateDiscoveryInputs(inputs: Record<string, unknown>): Record<string, string> {
  const memberId = inputs.memberId;
  if (typeof memberId !== "string" || !/^\d{5}$/.test(memberId)) {
    throw new AutomationError("invalid_input", "invalid_request", "memberId must contain exactly five digits.");
  }
  if (Object.keys(inputs).some((key) => key !== "memberId")) {
    throw new AutomationError("invalid_input", "invalid_request", "Discovery received an undeclared input.");
  }
  return { memberId };
}

function sanitizeCapabilityName(value: string | null): string {
  const candidate = (value ?? "get_savings_balance").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return candidate || "get_savings_balance";
}

export function compileDiscoveredCapability(options: {
  goal: string;
  provider: string;
  trace: RecordedAction[];
  capabilityName: string | null;
  generatedAt: string;
}): Capability {
  const has = (action: RecordedAction["action"], targetId: TargetId) => options.trace.some((item) => item.action === action && item.targetId === targetId);
  if (!has("type", "member_number") || !has("click", "retrieve_record") || !has("wait_for_outcome", "member_summary") || !has("extract", "savings_balance") || !has("extract", "account_status")) {
    throw new AutomationError("trace_incomplete", "hard_failure", "The successful discovery trace is missing required reusable actions.");
  }

  const artifact = {
    schemaVersion: "1.0",
    name: sanitizeCapabilityName(options.capabilityName),
    version: "1.0.0",
    description: `Discovered from goal: ${redactDiscoveryText(options.goal)}`,
    target: DISCOVERY_POLICY_CAPABILITY.target,
    inputs: DISCOVERY_POLICY_CAPABILITY.inputs,
    outputs: DISCOVERY_POLICY_CAPABILITY.outputs,
    policy: DISCOVERY_POLICY_CAPABILITY.policy,
    steps: options.trace.map((item, index) => {
      if (item.action === "type") return { id: `step_${index + 1}_type_member_id`, action: "type" as const, input: "memberId", target: TARGET_CATALOG.member_number };
      if (item.action === "click") return { id: `step_${index + 1}_submit_lookup`, action: "click" as const, target: TARGET_CATALOG.retrieve_record };
      if (item.action === "wait_for_outcome") return {
        id: `step_${index + 1}_wait_for_outcome`,
        action: "wait_for_outcome" as const,
        timeoutMs: 5000,
        outcomes: [
          { kind: "success" as const, target: TARGET_CATALOG.member_summary },
          { kind: "business_outcome" as const, code: "member_not_found", target: TARGET_CATALOG.member_not_found },
        ],
      };
      const output = item.output === "accountStatus" ? "accountStatus" : "balance";
      return { id: `step_${index + 1}_extract_${output}`, action: "extract" as const, output, target: output === "balance" ? TARGET_CATALOG.savings_balance : TARGET_CATALOG.account_status };
    }),
    checkpoint: DISCOVERY_POLICY_CAPABILITY.checkpoint,
    businessOutcomes: DISCOVERY_POLICY_CAPABILITY.businessOutcomes,
    discovery: {
      provider: options.provider,
      generatedAt: options.generatedAt,
      storesModelTranscript: false,
    },
  };
  return validateCapability(artifact);
}

export async function runDiscovery(options: {
  goal: string;
  inputs: Record<string, unknown>;
  origin: string;
  provider: DiscoveryProvider;
  adapter: DiscoveryAdapter;
  maxSteps?: number;
  runId?: string;
  now?: () => string;
  onEvidence?: (event: DiscoveryEvidenceEvent) => void;
}): Promise<DiscoveryResult> {
  const maxSteps = options.maxSteps ?? 8;
  const runId = options.runId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const evidence: DiscoveryEvidenceEvent[] = [];
  const history: DecisionContext["history"] = [];
  const trace: RecordedAction[] = [];
  const outputs: Record<string, string> = {};
  let currentStep = 0;
  let providerName = "unresolved";

  const record = (event: Omit<DiscoveryEvidenceEvent, "sequence" | "at">) => {
    const complete = { ...event, sequence: evidence.length + 1, at: now() };
    evidence.push(complete);
    options.onEvidence?.(complete);
  };

  try {
    if (typeof options.goal !== "string" || options.goal.trim().length < 12 || options.goal.length > 500) {
      throw new AutomationError("invalid_goal", "invalid_request", "Goal must be between 12 and 500 characters.");
    }
    const inputs = validateDiscoveryInputs(options.inputs);
    const safeGoal = redactDiscoveryText(options.goal.trim());
    if (!isAllowedTargetUrl(DISCOVERY_POLICY_CAPABILITY.target.entryPoint, options.origin, DISCOVERY_POLICY_CAPABILITY)) {
      throw new AutomationError("policy_denied", "policy_denied", "Discovery entry point is outside the route allowlist.");
    }
    record({ phase: "policy", step: 0, outcome: "ok", detail: "Goal, inputs, target route, action set, and read-only risk policy approved." });
    await options.adapter.prepare(DISCOVERY_POLICY_CAPABILITY.target.entryPoint);
    const startedAt = Date.now();

    for (currentStep = 1; currentStep <= maxSteps; currentStep += 1) {
      if (Date.now() - startedAt > DISCOVERY_POLICY_CAPABILITY.policy.runTimeoutMs) {
        throw new AutomationError("discovery_timeout", "recoverable", "Discovery exceeded its total timeout.", true);
      }
      if (!isAllowedTargetUrl(options.adapter.currentUrl(), options.origin, DISCOVERY_POLICY_CAPABILITY)) {
        throw new AutomationError("policy_denied", "policy_denied", "Discovery left the target route allowlist.");
      }
      const observation = await options.adapter.observe();
      record({ phase: "observe", step: currentStep, outcome: "ok", detail: `Observed ${observation.controls.length} policy-known controls; values remain local.` });
      const context: DecisionContext = {
        goal: safeGoal,
        step: currentStep,
        maxSteps,
        inputContract: { memberId: { type: "string", sensitive: true } },
        outputContract: { balance: { type: "currency" }, accountStatus: { type: "string" } },
        observation,
        history,
      };
      const providerDecision = await options.provider.decide(context);
      providerName = providerDecision.provider;
      const decision = validateDiscoveryDecision(providerDecision.decision, context);
      record({ phase: "decide", step: currentStep, outcome: "ok", detail: decision.reason, provider: providerName });

      if (decision.action === "complete") {
        if (!(await options.adapter.verify("member_summary")) || !outputs.balance || !outputs.accountStatus) {
          throw new AutomationError("goal_not_verified", "hard_failure", "The model declared completion before outputs and checkpoint were verified.");
        }
        const artifact = compileDiscoveredCapability({
          goal: safeGoal,
          provider: providerName,
          trace,
          capabilityName: decision.capabilityName,
          generatedAt: now(),
        });
        record({ phase: "compile", step: currentStep, outcome: "ok", detail: `Compiled and validated ${artifact.name}@${artifact.version} from ${trace.length} recorded actions.`, provider: providerName });
        record({ phase: "complete", step: currentStep, outcome: "ok", detail: "Goal verified; capability artifact and declared outputs are ready.", provider: providerName });
        return { runId, status: "success", provider: providerName, outputs, artifact, evidence };
      }

      const result = await options.adapter.execute(decision, inputs);
      const recorded = { action: decision.action, targetId: decision.targetId, input: decision.input, output: decision.output } as RecordedAction;
      history.push(recorded);
      trace.push(recorded);

      if (result.outcome === "business_outcome") {
        record({ phase: "act", step: currentStep, outcome: "business_outcome", detail: "Detected declared member_not_found outcome.", provider: providerName });
        return {
          runId,
          status: "business_outcome",
          provider: providerName,
          code: "member_not_found",
          message: "No member matched the supplied identifier.",
          evidence,
        };
      }
      if (decision.action === "extract" && decision.output && result.value) outputs[decision.output] = result.value;
      const detail = decision.action === "type"
        ? `Entered redacted ${decision.input} using ${result.locator}.`
        : decision.action === "extract"
          ? `Extracted declared ${decision.output} output locally.`
          : decision.action === "wait_for_outcome"
            ? "Observed a declared successful member lookup outcome."
            : `Activated ${decision.targetId} using ${result.locator}.`;
      record({ phase: "act", step: currentStep, outcome: "ok", detail, provider: providerName });
    }
    throw new AutomationError("max_steps_exceeded", "recoverable", "Discovery reached its maximum step count.", true);
  } catch (error) {
    const automationError = error instanceof AutomationError
      ? error
      : new AutomationError("unexpected_error", "hard_failure", error instanceof Error ? error.message : "Unknown discovery error.");
    record({ phase: "complete", step: currentStep, outcome: "error", detail: automationError.message, provider: providerName });
    return {
      runId,
      status: "failure",
      provider: providerName,
      error: { code: automationError.code, message: automationError.message, step: currentStep, retryable: automationError.retryable },
      evidence,
    };
  }
}

export function createSimulatedDiscoveryProvider(): DiscoveryProvider {
  return {
    async decide(context) {
      const actions = context.history.map((item) => `${item.action}:${item.output ?? item.targetId}`);
      let decision: DiscoveryDecision;
      if (!actions.includes("type:member_number")) {
        decision = { action: "type", targetId: "member_number", input: "memberId", output: null, reason: "The member lookup form requires the declared memberId input.", capabilityName: null };
      } else if (!actions.includes("click:retrieve_record")) {
        decision = { action: "click", targetId: "retrieve_record", input: null, output: null, reason: "The lookup form is ready, so submit the member inquiry.", capabilityName: null };
      } else if (!actions.includes("wait_for_outcome:member_summary")) {
        decision = { action: "wait_for_outcome", targetId: "member_summary", input: null, output: null, reason: "Wait for either the declared member summary or not-found outcome.", capabilityName: null };
      } else if (!actions.includes("extract:balance")) {
        decision = { action: "extract", targetId: "savings_balance", input: null, output: "balance", reason: "The member summary is visible; extract the declared savings balance locally.", capabilityName: null };
      } else if (!actions.includes("extract:accountStatus")) {
        decision = { action: "extract", targetId: "account_status", input: null, output: "accountStatus", reason: "Extract the remaining declared account status locally.", capabilityName: null };
      } else {
        decision = { action: "complete", targetId: "member_summary", input: null, output: null, reason: "Both outputs are present and the success checkpoint can now be verified.", capabilityName: "get_savings_balance" };
      }
      return { provider: "safe-simulator", decision };
    },
  };
}

export const DISCOVERY_OUTCOMES: OutcomeDefinition[] = [
  { kind: "success", target: TARGET_CATALOG.member_summary },
  { kind: "business_outcome", code: "member_not_found", target: TARGET_CATALOG.member_not_found },
];
