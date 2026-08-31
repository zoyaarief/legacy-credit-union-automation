import {
  AutomationError,
  HumanInterventionError,
  isAllowedTargetUrl,
  validateOutputValue,
  validateCapability,
  withOperationDeadline,
  type Capability,
  type ControlTarget,
  type HumanAction,
  type Locator,
  type SurfaceSnapshot,
} from "../automation/core.ts";
import { signResumeState, verifyResumeState } from "../resume-token.ts";

export type DiscoveryActionName =
  | "type"
  | "click"
  | "wait_for_change"
  | "extract"
  | "business_outcome"
  | "request_human"
  | "complete";

export type ObservedControl = {
  ref: string;
  role: "textbox" | "button" | "combobox" | "region" | "dialog" | "status" | "text";
  name: string;
  context: string;
  visible: boolean;
  enabled?: boolean;
  filled?: boolean;
  hasValue?: boolean;
  humanOnly?: boolean;
  outputBinding?: "balance" | "accountStatus";
  locatorCandidates: Locator[];
};

export type SurfaceObservation = {
  url: string;
  title: string;
  controls: ObservedControl[];
};

export type DiscoveryDecision = {
  action: DiscoveryActionName;
  controlRef: string | null;
  locators: Locator[];
  input: string | null;
  output: string | null;
  businessCode: string | null;
  interventionCode: string | null;
  reason: string;
  capabilityName: string | null;
  target: ControlTarget | null;
};

export type DiscoveryHistoryEntry = {
  action: DiscoveryActionName;
  controlRef: string | null;
  targetName: string | null;
  input: string | null;
  output: string | null;
  targetKey: string | null;
};

export type DecisionContext = {
  goal: string;
  step: number;
  maxSteps: number;
  inputContract: Record<string, { type: "string"; sensitive: boolean }>;
  outputContract: Record<string, { type: "currency" | "string"; currency?: string; allowedValues?: string[] }>;
  observation: SurfaceObservation;
  history: DiscoveryHistoryEntry[];
};

export type ProviderDecision = { provider: string; decision: DiscoveryDecision };
export type DiscoveryProvider = { decide(context: DecisionContext, signal: AbortSignal): Promise<ProviderDecision> };

export type DiscoveryAdapterResult = {
  locator?: string;
  value?: string;
};

export type DiscoveryAdapter = {
  prepare(entryPoint: string, signal: AbortSignal): Promise<void>;
  currentUrl(): string;
  sessionIdentity?(): string;
  snapshot?(signal: AbortSignal): Promise<SurfaceSnapshot>;
  observe(signal: AbortSignal): Promise<SurfaceObservation>;
  execute(decision: DiscoveryDecision, inputs: Record<string, string>, signal: AbortSignal): Promise<DiscoveryAdapterResult>;
  verify(target: ControlTarget, signal: AbortSignal): Promise<boolean>;
};

export type DiscoveryEvidenceEvent = {
  sequence: number;
  at: string;
  phase: "policy" | "observe" | "decide" | "act" | "handoff" | "resume" | "compile" | "complete";
  step: number;
  outcome: "ok" | "business_outcome" | "intervention" | "error";
  detail: string;
  provider?: string;
};

export type DiscoveryRecordedAction = {
  action: "type" | "click" | "wait_for_change" | "extract";
  target: ControlTarget | null;
  controlRef: string | null;
  input: string | null;
  output: string | null;
};

export type DiscoveryResume = {
  token: string;
};

type DiscoveryResumeState = {
  runId: string;
  step: number;
  history: DiscoveryHistoryEntry[];
  trace: DiscoveryRecordedAction[];
  outputs: Record<string, string>;
  evidence: DiscoveryEvidenceEvent[];
  provider: string;
  binding: DiscoveryBinding;
};

export type DiscoveryBinding = {
  goalFingerprint: string;
  inputFingerprint: string;
  targetFingerprint: string;
  origin: string;
  sessionIdentity: string;
  step: number;
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
      status: "human_required";
      provider: string;
      intervention: { code: string; message: string; step: number; snapshot: SurfaceSnapshot };
      resume: DiscoveryResume;
      evidence: DiscoveryEvidenceEvent[];
    }
  | {
      runId: string;
      status: "failure";
      provider: string;
      error: { code: string; message: string; step: number; retryable: boolean; snapshot?: SurfaceSnapshot };
      evidence: DiscoveryEvidenceEvent[];
    };

const DISCOVERY_TARGET_POLICY = {
  target: {
    surface: "web" as const,
    application: "northstar-core-member-services",
    entryPoint: "/legacy",
    allowlist: { sameOrigin: true, pathPrefixes: ["/legacy"] },
  },
} satisfies Pick<Capability, "target">;

const DISCOVERY_MAX_STEPS = 8;
const DISCOVERY_TIMEOUT_MS = 20_000;

// A successful lookup cannot expose the mutually exclusive not-found state. This
// matcher remains domain policy; successful-path controls come from the live trace.
const MEMBER_NOT_FOUND_TARGET: ControlTarget = {
  description: "Member-not-found business outcome",
  locators: [
    { kind: "css", value: ".legacy-message" },
    { kind: "css", value: ".legacy-content > .legacy-message" },
  ],
};

const TARGET_ACTIONS = new Set<DiscoveryActionName>(["type", "click", "extract", "business_outcome", "request_human", "complete"]);
const ROLE_POLICY: Partial<Record<DiscoveryActionName, ObservedControl["role"][]>> = {
  type: ["textbox", "combobox"],
  click: ["button"],
  extract: ["text"],
  business_outcome: ["status", "region", "text"],
  request_human: ["dialog"],
  complete: ["region"],
};

export function redactDiscoveryText(value: string): string {
  return value
    .replace(/\b\d{5,}\b/g, "[REDACTED_ID]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/(?:sk|api|token)[-_][A-Za-z0-9_-]{12,}/gi, "[REDACTED_SECRET]");
}

function parseLocator(value: unknown): Locator | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!["name", "css", "button_text"].includes(String(candidate.kind))) return null;
  if (typeof candidate.value !== "string" || candidate.value.length === 0 || candidate.value.length > 240) return null;
  return { kind: candidate.kind as Locator["kind"], value: candidate.value };
}

function sameLocator(left: Locator, right: Locator) {
  return left.kind === right.kind && left.value === right.value;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeDiscoveryTarget(rawTarget: string, origin: string): string {
  if (typeof rawTarget !== "string" || rawTarget.length === 0 || rawTarget.length > 240) {
    throw new AutomationError("invalid_target", "invalid_request", "Target must be a permitted application entry point.");
  }
  let url: URL;
  try { url = new URL(rawTarget, origin); } catch {
    throw new AutomationError("invalid_target", "invalid_request", "Target must be a valid URL or absolute path.");
  }
  if (!isAllowedTargetUrl(url.href, origin, DISCOVERY_TARGET_POLICY)) {
    throw new AutomationError("policy_denied", "policy_denied", "Discovery target is outside the configured application allowlist.");
  }
  return `${url.pathname}${url.search}`;
}

export function validateDiscoveryDecision(decision: unknown, context: DecisionContext): DiscoveryDecision {
  if (typeof decision !== "object" || decision === null) {
    throw new AutomationError("model_contract_invalid", "hard_failure", "The model returned an invalid decision object.");
  }
  const candidate = decision as Record<string, unknown>;
  const action = String(candidate.action) as DiscoveryActionName;
  if (!["type", "click", "wait_for_change", "extract", "business_outcome", "request_human", "complete"].includes(action)) {
    throw new AutomationError("model_contract_invalid", "hard_failure", "The model returned an unsupported action.");
  }
  if (typeof candidate.reason !== "string" || candidate.reason.length === 0 || candidate.reason.length > 240) {
    throw new AutomationError("model_contract_invalid", "hard_failure", "The model decision needs a concise reason.");
  }

  const controlRef = candidate.controlRef === null ? null : String(candidate.controlRef);
  const input = candidate.input === null ? null : String(candidate.input);
  const output = candidate.output === null ? null : String(candidate.output);
  const businessCode = candidate.businessCode === null ? null : String(candidate.businessCode);
  const interventionCode = candidate.interventionCode === null ? null : String(candidate.interventionCode);
  const capabilityName = candidate.capabilityName === null ? null : String(candidate.capabilityName);
  const rawLocators = Array.isArray(candidate.locators) ? candidate.locators : [];

  let target: ControlTarget | null = null;
  if (TARGET_ACTIONS.has(action)) {
    const control = context.observation.controls.find((item) => item.ref === controlRef && item.visible);
    if (!control) throw new AutomationError("target_not_observed", "hard_failure", "The model selected a control that is not visible in the current observation.");
    if (!(ROLE_POLICY[action] ?? []).includes(control.role)) {
      throw new AutomationError("policy_denied", "policy_denied", `A ${control.role} control is not allowed for ${action}.`);
    }
    if (["type", "click"].includes(action) && control.enabled === false) {
      throw new AutomationError("target_not_interactable", "hard_failure", "The selected control is visible but disabled.");
    }
    if (action === "click" && control.humanOnly) {
      throw new AutomationError("human_only_control", "policy_denied", "Automation cannot activate a human-only control.");
    }
    const locators = rawLocators.map(parseLocator);
    if (locators.length !== 2 || locators.some((item) => item === null)) {
      throw new AutomationError("model_contract_invalid", "hard_failure", "The model must select two ordered locator candidates for the observed control.");
    }
    const typedLocators = locators as Locator[];
    if (typedLocators.some((locator) => !control.locatorCandidates.some((allowed) => sameLocator(locator, allowed)))) {
      throw new AutomationError("policy_denied", "policy_denied", "The model proposed a locator that was not derived from the observed control.");
    }
    target = {
      description: redactDiscoveryText(`${control.name}${control.context ? ` — ${control.context}` : ""}`).slice(0, 240),
      locators: typedLocators,
    };
  } else if (controlRef !== null || rawLocators.length !== 0) {
    throw new AutomationError("model_contract_invalid", "hard_failure", `${action} must not select a control or locator.`);
  }

  if (action === "type" && (input !== "memberId" || !Object.hasOwn(context.inputContract, input))) {
    throw new AutomationError("policy_denied", "policy_denied", "The model referenced an undeclared input.");
  }
  if (action !== "type" && input !== null) throw new AutomationError("model_contract_invalid", "hard_failure", "Only type may reference an input.");
  if (action === "extract" && (!output || !Object.hasOwn(context.outputContract, output))) {
    throw new AutomationError("policy_denied", "policy_denied", "The model referenced an undeclared output.");
  }
  if (action === "extract") {
    const control = context.observation.controls.find((item) => item.ref === controlRef);
    if (!control || control.outputBinding !== output) {
      throw new AutomationError("output_target_mismatch", "policy_denied", `The selected control is not semantically bound to ${output}.`);
    }
    const selectedKey = target?.locators.map((locator) => `${locator.kind}:${locator.value}`).sort().join("|") ?? "";
    if (context.history.some((entry) => entry.action === "extract" && entry.targetKey === selectedKey)) {
      throw new AutomationError("output_target_reused", "policy_denied", "Distinct outputs must be extracted from distinct controls.");
    }
  }
  if (action !== "extract" && output !== null) throw new AutomationError("model_contract_invalid", "hard_failure", "Only extract may declare an output.");
  if (action === "business_outcome" && businessCode !== "member_not_found") {
    throw new AutomationError("policy_denied", "policy_denied", "The model reported an undeclared business outcome.");
  }
  if (action !== "business_outcome" && businessCode !== null) throw new AutomationError("model_contract_invalid", "hard_failure", "Only a business outcome may declare a business code.");
  if (action === "request_human" && interventionCode !== "operator_acknowledgment_required") {
    throw new AutomationError("policy_denied", "policy_denied", "The model reported an undeclared intervention.");
  }
  if (action !== "request_human" && interventionCode !== null) throw new AutomationError("model_contract_invalid", "hard_failure", "Only a handoff may declare an intervention code.");

  return {
    action,
    controlRef,
    locators: target?.locators ?? [],
    input,
    output,
    businessCode,
    interventionCode,
    reason: redactDiscoveryText(candidate.reason),
    capabilityName,
    target,
  };
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

const SUPPORTED_GOAL_PATTERNS = [
  /^(?:please\s+)?(?:look\s*up|find|retrieve|query|check|view|read|get|show)\s+(?:the\s+)?member(?:\s+(?:\{\{memberId\}\}|memberId|\d{5}))?\s+and\s+(?:return|report|read|show|get|display)\s+(?:the\s+)?(?:current\s+)?savings(?:\s+account)?\s+balance\s+and\s+(?:the\s+)?(?:account\s+)?status(?:\s+please)?[.!]?$/i,
  /^(?:please\s+)?(?:get|read|show|display|report|return|retrieve)\s+(?:the\s+)?(?:current\s+)?savings(?:\s+account)?\s+balance\s+and\s+(?:the\s+)?(?:account\s+)?status\s+for\s+(?:the\s+)?member(?:\s+(?:\{\{memberId\}\}|memberId|\d{5}))?(?:\s+please)?[.!]?$/i,
  /^(?:please\s+)?(?:get|read|show|display|report|return|retrieve|check|view|query)\s+(?:the\s+)?member(?:\s+(?:\{\{memberId\}\}|memberId|\d{5}))?['’]s\s+(?:current\s+)?savings(?:\s+account)?\s+balance\s+and\s+(?:account\s+)?status(?:\s+please)?[.!]?$/i,
];

export function classifySupportedDiscoveryGoal(goal: string): "get_savings_balance" | null {
  const normalized = goal.trim().replace(/\s+/g, " ");
  return SUPPORTED_GOAL_PATTERNS.some((pattern) => pattern.test(normalized)) ? "get_savings_balance" : null;
}

export function validateSupportedDiscoveryGoal(goal: string): string {
  if (typeof goal !== "string" || goal.trim().length < 12 || goal.length > 500) {
    throw new AutomationError("invalid_goal", "invalid_request", "Goal must be between 12 and 500 characters.");
  }
  const normalized = goal.trim().replace(/\s+/g, " ");
  if (!classifySupportedDiscoveryGoal(normalized)) {
    throw new AutomationError(
      "unsupported_goal",
      "invalid_request",
      "This discovery policy supports only a read-only member savings balance and account-status lookup.",
    );
  }
  return redactDiscoveryText(normalized);
}

function sanitizeCapabilityName(value: string | null): string {
  const candidate = (value ?? "get_savings_balance").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return candidate || "get_savings_balance";
}

export function compileDiscoveredCapability(options: {
  goal: string;
  provider: string;
  trace: DiscoveryRecordedAction[];
  checkpointTarget: ControlTarget;
  capabilityName: string | null;
  generatedAt: string;
  targetEntryPoint?: string;
}): Capability {
  const typeStep = options.trace.find((item) => item.action === "type" && item.input === "memberId" && item.target);
  const clickStep = options.trace.find((item) => item.action === "click" && item.target);
  const waitStep = options.trace.find((item) => item.action === "wait_for_change");
  const balanceStep = options.trace.find((item) => item.action === "extract" && item.output === "balance" && item.target);
  const statusStep = options.trace.find((item) => item.action === "extract" && item.output === "accountStatus" && item.target);
  if (!typeStep || !clickStep || !waitStep || !balanceStep || !statusStep) {
    throw new AutomationError("trace_incomplete", "hard_failure", "The successful discovery trace is missing required reusable actions.");
  }

  const steps = options.trace.map((item, index) => {
    if (item.action === "type" && item.target) return { id: `step_${index + 1}_type_member_id`, action: "type" as const, input: "memberId", target: item.target };
    if (item.action === "click" && item.target) return { id: `step_${index + 1}_submit_lookup`, action: "click" as const, target: item.target };
    if (item.action === "wait_for_change") return {
      id: `step_${index + 1}_wait_for_outcome`,
      action: "wait_for_outcome" as const,
      timeoutMs: 5000,
      outcomes: [
        { kind: "success" as const, target: options.checkpointTarget },
        { kind: "business_outcome" as const, code: "member_not_found", target: MEMBER_NOT_FOUND_TARGET },
      ],
    };
    if (item.action === "extract" && item.target && item.output) return { id: `step_${index + 1}_extract_${item.output}`, action: "extract" as const, output: item.output, target: item.target };
    throw new AutomationError("trace_invalid", "hard_failure", "The discovery trace contains an action that cannot be compiled.");
  });

  const artifact = {
    schemaVersion: "1.0",
    name: sanitizeCapabilityName(options.capabilityName),
    version: "1.2.0",
    description: `Discovered from goal: ${redactDiscoveryText(options.goal)}`,
    target: { ...DISCOVERY_TARGET_POLICY.target, entryPoint: options.targetEntryPoint ?? DISCOVERY_TARGET_POLICY.target.entryPoint },
    inputs: { memberId: { type: "string" as const, required: true, pattern: "^[0-9]{5}$", sensitive: true } },
    outputs: { balance: { type: "currency" as const, currency: "USD" }, accountStatus: { type: "string" as const, allowedValues: ["Active", "Restricted"] } },
    policy: {
      allowedActions: ["type", "click", "wait_for_outcome", "extract"],
      risk: "read_only" as const,
      maxSteps: DISCOVERY_MAX_STEPS,
      runTimeoutMs: DISCOVERY_TIMEOUT_MS,
      requiresHumanApproval: false,
    },
    steps,
    checkpoint: { kind: "element_visible" as const, target: options.checkpointTarget },
    businessOutcomes: [{ code: "member_not_found", message: "No member matched the supplied identifier.", retryable: false }],
    discovery: { provider: options.provider, generatedAt: options.generatedAt, storesModelTranscript: false },
  };
  return validateCapability(artifact);
}

function interventionSnapshot(observation: SurfaceObservation): SurfaceSnapshot {
  let path = "/legacy";
  try { path = new URL(observation.url).pathname; } catch { /* URL policy is checked separately. */ }
  return {
    surface: "web",
    path,
    title: observation.title,
    visibleSignals: observation.controls.slice(0, 8).map((control) => redactDiscoveryText(control.name)),
  };
}

export async function runDiscovery(options: {
  goal: string;
  target: string;
  inputs: Record<string, unknown>;
  origin: string;
  provider: DiscoveryProvider;
  adapter: DiscoveryAdapter;
  maxSteps?: number;
  runId?: string;
  now?: () => string;
  resume?: DiscoveryResume;
  humanActions?: HumanAction[];
  onEvidence?: (event: DiscoveryEvidenceEvent) => void;
}): Promise<DiscoveryResult> {
  const maxSteps = options.maxSteps ?? DISCOVERY_MAX_STEPS;
  let runId = options.runId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const evidence: DiscoveryEvidenceEvent[] = [];
  const history: DiscoveryHistoryEntry[] = [];
  const trace: DiscoveryRecordedAction[] = [];
  const outputs: Record<string, string> = {};
  let currentStep = 0;
  let providerName = "unresolved";
  let resumeState: DiscoveryResumeState | null = null;
  let activeBinding: DiscoveryBinding | null = null;

  const record = (event: Omit<DiscoveryEvidenceEvent, "sequence" | "at">) => {
    const complete = { ...event, sequence: evidence.length + 1, at: now() };
    evidence.push(complete);
    options.onEvidence?.(complete);
  };

  try {
    if (options.resume) {
      if (typeof options.resume.token !== "string" || !options.resume.token) throw new AutomationError("resume_token_invalid", "policy_denied", "The discovery resume token is missing or malformed.");
      try {
        resumeState = await verifyResumeState<DiscoveryResumeState>("discovery", options.resume.token);
      } catch {
        throw new AutomationError("resume_token_invalid", "policy_denied", "The discovery resume token failed integrity or expiry validation.");
      }
      runId = resumeState.runId;
      currentStep = resumeState.step;
      providerName = resumeState.provider;
      evidence.push(...resumeState.evidence);
      history.push(...resumeState.history);
      trace.push(...resumeState.trace);
      Object.assign(outputs, resumeState.outputs);
    }
    const safeGoal = validateSupportedDiscoveryGoal(options.goal);
    const inputs = validateDiscoveryInputs(options.inputs);
    const targetEntryPoint = normalizeDiscoveryTarget(options.target, options.origin);
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
    const goalFingerprint = await fingerprint(safeGoal);
    const inputFingerprint = await fingerprint(inputs);
    const targetFingerprint = await fingerprint({ ...DISCOVERY_TARGET_POLICY.target, entryPoint: targetEntryPoint });
    if (!resumeState) {
      record({ phase: "policy", step: 0, outcome: "ok", detail: "Goal, inputs, target route, action set, and read-only risk policy approved." });
      await withOperationDeadline((signal) => options.adapter.prepare(targetEntryPoint, signal), Math.max(1, deadline - Date.now()), "discovery_timeout", "Discovery target preparation exceeded its total timeout.");
    } else {
      const expected = resumeState.binding;
      const sessionIdentity = options.adapter.sessionIdentity?.() ?? options.adapter.currentUrl();
      if (
        !expected
        || expected.goalFingerprint !== goalFingerprint
        || expected.inputFingerprint !== inputFingerprint
        || expected.targetFingerprint !== targetFingerprint
        || expected.origin !== options.origin
        || expected.sessionIdentity !== sessionIdentity
        || expected.step !== resumeState.step
      ) {
        throw new AutomationError("resume_context_mismatch", "policy_denied", "The discovery resume token does not match the original goal, inputs, target, session, or step.");
      }
      for (const action of options.humanActions ?? []) {
        record({ phase: "handoff", step: currentStep, outcome: "ok", detail: `Human ${action.kind} on ${redactDiscoveryText(action.control)}; values were not recorded.`, provider: providerName });
      }
      record({ phase: "resume", step: currentStep, outcome: "ok", detail: "Human returned control; target policy and live-session context revalidated.", provider: providerName });
    }
    activeBinding = {
      goalFingerprint,
      inputFingerprint,
      targetFingerprint,
      origin: options.origin,
      sessionIdentity: options.adapter.sessionIdentity?.() ?? options.adapter.currentUrl(),
      step: currentStep,
    };

    const outputContract: DecisionContext["outputContract"] = { balance: { type: "currency", currency: "USD" }, accountStatus: { type: "string", allowedValues: ["Active", "Restricted"] } };
    for (const [name, value] of Object.entries(outputs)) {
      const spec = outputContract[name];
      if (!spec) throw new AutomationError("resume_context_mismatch", "policy_denied", `Discovery resume token contains undeclared output ${name}.`);
      outputs[name] = validateOutputValue(name, spec, value);
    }

    for (currentStep = resumeState?.step ?? 1; currentStep <= maxSteps; currentStep += 1) {
      if (Date.now() >= deadline) throw new AutomationError("discovery_timeout", "recoverable", "Discovery exceeded its total timeout.", true);
      activeBinding = { ...activeBinding, step: currentStep };
      if (!isAllowedTargetUrl(options.adapter.currentUrl(), options.origin, DISCOVERY_TARGET_POLICY)) {
        throw new AutomationError("policy_denied", "policy_denied", "Discovery left the target route allowlist.");
      }
      const observation = await withOperationDeadline((signal) => options.adapter.observe(signal), Math.max(1, deadline - Date.now()), "discovery_timeout", "Surface observation exceeded the discovery timeout.");
      record({ phase: "observe", step: currentStep, outcome: "ok", detail: `Observed ${observation.controls.length} sanitized live controls with DOM-derived locator candidates; values remain local.` });
      const context: DecisionContext = {
        goal: safeGoal,
        step: currentStep,
        maxSteps,
        inputContract: { memberId: { type: "string", sensitive: true } },
        outputContract,
        observation,
        history,
      };
      const providerDecision = await withOperationDeadline((signal) => options.provider.decide(context, signal), Math.max(1, deadline - Date.now()), "discovery_timeout", "The discovery provider exceeded the total timeout.");
      providerName = providerDecision.provider;
      const decision = validateDiscoveryDecision(providerDecision.decision, context);
      record({ phase: "decide", step: currentStep, outcome: "ok", detail: decision.reason, provider: providerName });

      if (decision.action === "business_outcome") {
        record({ phase: "act", step: currentStep, outcome: "business_outcome", detail: "Model identified the declared member_not_found state from the live surface.", provider: providerName });
        return { runId, status: "business_outcome", provider: providerName, code: "member_not_found", message: "No member matched the supplied identifier.", evidence };
      }
      if (decision.action === "request_human") {
        throw new HumanInterventionError(
          "operator_acknowledgment_required",
          "Discovery identified an operator-only acknowledgment and routed the same live session to a human.",
          interventionSnapshot(observation),
        );
      }
      if (decision.action === "complete") {
        if (!decision.target || !(await withOperationDeadline((signal) => options.adapter.verify(decision.target!, signal), Math.max(1, deadline - Date.now()), "discovery_timeout", "Checkpoint verification exceeded the discovery timeout.")) || !outputs.balance || !outputs.accountStatus) {
          throw new AutomationError("goal_not_verified", "hard_failure", "The model declared completion before outputs and checkpoint were verified.");
        }
        const artifact = compileDiscoveredCapability({
          goal: safeGoal,
          provider: providerName,
          trace,
          checkpointTarget: decision.target,
          capabilityName: decision.capabilityName,
          generatedAt: now(),
          targetEntryPoint,
        });
        record({ phase: "compile", step: currentStep, outcome: "ok", detail: `Compiled and validated ${artifact.name}@${artifact.version} from ${trace.length} model-selected live-surface actions.`, provider: providerName });
        record({ phase: "complete", step: currentStep, outcome: "ok", detail: "Goal verified; capability artifact and declared outputs are ready.", provider: providerName });
        return { runId, status: "success", provider: providerName, outputs, artifact, evidence };
      }

      const result = await withOperationDeadline((signal) => options.adapter.execute(decision, inputs, signal), Math.max(1, deadline - Date.now()), "discovery_timeout", "A discovery action exceeded the total timeout.");
      const recorded: DiscoveryRecordedAction = { action: decision.action, target: decision.target, controlRef: decision.controlRef, input: decision.input, output: decision.output };
      history.push({ action: decision.action, controlRef: decision.controlRef, targetName: decision.target?.description ?? null, input: decision.input, output: decision.output, targetKey: decision.target ? decision.target.locators.map((locator) => `${locator.kind}:${locator.value}`).sort().join("|") : null });
      trace.push(recorded);

      if (decision.action === "extract" && decision.output && result.value) {
        outputs[decision.output] = validateOutputValue(decision.output, context.outputContract[decision.output], result.value);
      }
      const detail = decision.action === "type"
        ? `Entered redacted ${decision.input} using discovered ${result.locator}.`
        : decision.action === "extract"
          ? `Extracted declared ${decision.output} output locally using discovered ${result.locator}.`
          : decision.action === "wait_for_change"
            ? "Observed the live surface change after submission."
            : `Activated the model-selected ${decision.target?.description} using discovered ${result.locator}.`;
      record({ phase: "act", step: currentStep, outcome: "ok", detail, provider: providerName });
    }
    throw new AutomationError("max_steps_exceeded", "recoverable", "Discovery reached its maximum step count.", true);
  } catch (error) {
    if (error instanceof HumanInterventionError) {
      record({ phase: "handoff", step: currentStep, outcome: "intervention", detail: error.message, provider: providerName });
      const resume: DiscoveryResume = { token: await signResumeState<DiscoveryResumeState>("discovery", {
        runId,
        step: currentStep,
        history: [...history],
        trace: [...trace],
        outputs: { ...outputs },
        evidence: [...evidence],
        provider: providerName,
        binding: { ...(activeBinding ?? { goalFingerprint: "", inputFingerprint: "", targetFingerprint: "", origin: options.origin, sessionIdentity: options.adapter.currentUrl(), step: currentStep }), step: currentStep },
      }) };
      return { runId, status: "human_required", provider: providerName, intervention: { code: error.code, message: error.message, step: currentStep, snapshot: error.snapshot }, resume, evidence };
    }
    const automationError = error instanceof AutomationError
      ? error
      : new AutomationError("unexpected_error", "hard_failure", error instanceof Error ? error.message : "Unknown discovery error.");
    let snapshot: SurfaceSnapshot | undefined;
    if (options.adapter.snapshot) {
      try { snapshot = await withOperationDeadline((signal) => options.adapter.snapshot!(signal), 1000, "snapshot_timeout", "Failure snapshot timed out."); } catch { /* Preserve the original failure. */ }
    }
    record({ phase: "complete", step: currentStep, outcome: "error", detail: automationError.message, provider: providerName });
    return { runId, status: "failure", provider: providerName, error: { code: automationError.code, message: automationError.message, step: currentStep, retryable: automationError.retryable, snapshot }, evidence };
  }
}

function modelTarget(control: ObservedControl) {
  return { controlRef: control.ref, locators: control.locatorCandidates.slice(0, 2) };
}

function simulatedRawDecision(context: DecisionContext): Record<string, unknown> {
  const acted = new Set(context.history.map((item) => `${item.action}:${item.output ?? item.input ?? ""}`));
  const controls = context.observation.controls;
  const base = { input: null, output: null, businessCode: null, interventionCode: null, capabilityName: null };
  const notFound = controls.find((control) => /not found|no member matched/i.test(`${control.name} ${control.context}`));
  if (notFound) return { ...base, ...modelTarget(notFound), action: "business_outcome", businessCode: "member_not_found", reason: "The live surface shows the declared member-not-found business outcome." };
  const dialog = controls.find((control) => control.role === "dialog" && /authori[sz]ation|acknowledg|restricted/i.test(`${control.name} ${control.context}`));
  if (dialog) return { ...base, ...modelTarget(dialog), action: "request_human", interventionCode: "operator_acknowledgment_required", reason: "The live surface requires an operator-only acknowledgment." };
  if (!acted.has("type:memberId")) {
    const control = controls.find((item) => item.role === "textbox" && /member number|member id/i.test(`${item.name} ${item.context}`));
    if (control) return { ...base, ...modelTarget(control), action: "type", input: "memberId", reason: "The observed member-number field matches the declared sensitive input." };
  }
  if (!context.history.some((item) => item.action === "click")) {
    const control = controls.find((item) => item.role === "button" && /retrieve|find|search|lookup/i.test(item.name) && item.enabled !== false);
    if (control) return { ...base, ...modelTarget(control), action: "click", reason: "The observed lookup button submits the populated member inquiry." };
  }
  if (!context.history.some((item) => item.action === "wait_for_change")) {
    return { ...base, action: "wait_for_change", controlRef: null, locators: [], reason: "Wait for the submitted surface to reveal a result, error, or intervention." };
  }
  if (!acted.has("extract:balance")) {
    const control = controls.find((item) => item.role === "text" && /current balance|savings balance/i.test(`${item.name} ${item.context}`) && item.hasValue);
    if (control) return { ...base, ...modelTarget(control), action: "extract", output: "balance", reason: "The observed savings-row balance cell matches the declared currency output." };
  }
  if (!acted.has("extract:accountStatus")) {
    const control = controls.find((item) => item.role === "text" && /account status|status cell/i.test(`${item.name} ${item.context}`) && item.hasValue);
    if (control) return { ...base, ...modelTarget(control), action: "extract", output: "accountStatus", reason: "The observed savings-row status cell matches the remaining declared output." };
  }
  const checkpoint = controls.find((item) => item.role === "region" && /member.*account summary|account summary/i.test(`${item.name} ${item.context}`));
  if (checkpoint) return { ...base, ...modelTarget(checkpoint), action: "complete", capabilityName: "get_savings_balance", reason: "Both outputs are recorded and the observed member-summary region is a verifiable checkpoint." };
  return { ...base, action: "wait_for_change", controlRef: null, locators: [], reason: "The required control is not yet visible; wait for another live-surface change." };
}

export function createSimulatedDiscoveryProvider(): DiscoveryProvider {
  return {
    async decide(context, signal) {
      signal?.throwIfAborted();
      return { provider: "safe-simulator", decision: validateDiscoveryDecision(simulatedRawDecision(context), context) };
    },
  };
}
