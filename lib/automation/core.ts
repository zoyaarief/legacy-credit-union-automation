import { signResumeState, verifyResumeState } from "../resume-token.ts";

export type Locator = {
  kind: "name" | "css" | "button_text";
  value: string;
};

export type ControlTarget = {
  description: string;
  locators: Locator[];
};

export type InputSpec = {
  type: "string";
  required: boolean;
  pattern?: string;
  sensitive?: boolean;
};

export type OutputSpec = {
  type: "string" | "currency";
  currency?: string;
  allowedValues?: string[];
};

export type OutcomeDefinition =
  | { kind: "success"; target: ControlTarget }
  | { kind: "business_outcome"; code: string; target: ControlTarget };

export type CapabilityStep =
  | { id: string; action: "type"; input: string; target: ControlTarget }
  | { id: string; action: "click"; target: ControlTarget }
  | { id: string; action: "wait_for_outcome"; timeoutMs: number; outcomes: OutcomeDefinition[] }
  | { id: string; action: "extract"; output: string; target: ControlTarget };

export type Capability = {
  schemaVersion: "1.0";
  name: string;
  version: string;
  description: string;
  target: {
    surface: "web";
    application: string;
    entryPoint: string;
    allowlist: { sameOrigin: boolean; pathPrefixes: string[] };
  };
  inputs: Record<string, InputSpec>;
  outputs: Record<string, OutputSpec>;
  policy: {
    allowedActions: CapabilityStep["action"][];
    risk: "read_only" | "reversible" | "irreversible";
    maxSteps: number;
    runTimeoutMs: number;
    requiresHumanApproval: boolean;
  };
  steps: CapabilityStep[];
  checkpoint: { kind: "element_visible"; target: ControlTarget };
  businessOutcomes: Array<{ code: string; message: string; retryable: boolean }>;
};

export type EvidenceEvent = {
  sequence: number;
  at: string;
  stepId: string;
  action: "policy_check" | "checkpoint" | "handoff" | "human_action" | "resume" | "recovery" | CapabilityStep["action"];
  outcome: "ok" | "business_outcome" | "intervention" | "error";
  detail: string;
};

export type SurfaceSnapshot = {
  surface: "web";
  path: string;
  title: string;
  visibleSignals: string[];
  sanitizedDom?: string;
};

export type HumanAction = {
  at: string;
  kind: "click" | "input";
  control: string;
};

export type ReplayResume = {
  token: string;
};

type ReplayResumeState = {
  runId: string;
  stepIndex: number;
  outputs: Record<string, string>;
  evidence: EvidenceEvent[];
  binding: ReplayBinding;
};

export type ReplayBinding = {
  artifactFingerprint: string;
  targetFingerprint: string;
  inputFingerprint: string;
  origin: string;
  sessionIdentity: string;
  stepIndex: number;
};

export type FailureCategory = "invalid_request" | "policy_denied" | "recoverable" | "hard_failure";

export type ReplayResult =
  | { runId: string; status: "success"; outputs: Record<string, string>; evidence: EvidenceEvent[] }
  | { runId: string; status: "business_outcome"; code: string; message: string; retryable: boolean; evidence: EvidenceEvent[] }
  | {
      runId: string;
      status: "human_required";
      intervention: { code: string; message: string; stepId: string; snapshot: SurfaceSnapshot };
      resume: ReplayResume;
      evidence: EvidenceEvent[];
    }
  | {
      runId: string;
      status: "failure";
      error: { category: FailureCategory; code: string; stepId: string; message: string; retryable: boolean; snapshot?: SurfaceSnapshot };
      evidence: EvidenceEvent[];
    };

export type SurfaceAdapter = {
  prepare(entryPoint: string, signal: AbortSignal): Promise<void>;
  currentUrl(): string;
  sessionIdentity?(): string;
  snapshot?(signal: AbortSignal): Promise<SurfaceSnapshot>;
  type(target: ControlTarget, value: string, signal: AbortSignal): Promise<string>;
  click(target: ControlTarget, signal: AbortSignal): Promise<string>;
  waitForOutcome(outcomes: OutcomeDefinition[], timeoutMs: number, signal: AbortSignal): Promise<OutcomeDefinition>;
  extract(target: ControlTarget, signal: AbortSignal): Promise<string | { value: string; locator: string }>;
  verify(target: ControlTarget, signal: AbortSignal): Promise<boolean>;
};

export class AutomationError extends Error {
  readonly code: string;
  readonly category: FailureCategory;
  readonly retryable: boolean;

  constructor(code: string, category: FailureCategory, message: string, retryable = false) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
  }
}

export class HumanInterventionError extends Error {
  readonly code: string;
  readonly snapshot: SurfaceSnapshot;

  constructor(code: string, message: string, snapshot: SurfaceSnapshot) {
    super(message);
    this.name = "HumanInterventionError";
    this.code = code;
    this.snapshot = snapshot;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function remainingMs(deadline: number, code: string, message: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AutomationError(code, "recoverable", message, true);
  return remaining;
}

export async function withOperationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: string,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AutomationError(code, "recoverable", message, true);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const timeout = new AutomationError(code, "recoverable", message, true);
          reject(timeout);
          controller.abort(timeout);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertTarget(value: unknown, label: string): asserts value is ControlTarget {
  if (!isRecord(value) || typeof value.description !== "string" || !Array.isArray(value.locators) || value.locators.length < 2) {
    throw new AutomationError("artifact_invalid", "hard_failure", `${label} must declare a description and at least two locators.`);
  }
  for (const locator of value.locators) {
    if (!isRecord(locator) || !["name", "css", "button_text"].includes(String(locator.kind)) || typeof locator.value !== "string") {
      throw new AutomationError("artifact_invalid", "hard_failure", `${label} contains an unsupported locator.`);
    }
  }
}

export function validateCapability(value: unknown): Capability {
  if (!isRecord(value) || value.schemaVersion !== "1.0" || typeof value.name !== "string" || !value.name || typeof value.version !== "string" || !value.version || typeof value.description !== "string") {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability identity or schema version is invalid.");
  }
  if (!isRecord(value.target) || value.target.surface !== "web" || typeof value.target.application !== "string" || !value.target.application || typeof value.target.entryPoint !== "string" || !isRecord(value.target.allowlist)) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability target policy is invalid.");
  }
  const pathPrefixes = value.target.allowlist.pathPrefixes;
  if (typeof value.target.allowlist.sameOrigin !== "boolean" || !value.target.entryPoint.startsWith("/") || !Array.isArray(pathPrefixes) || pathPrefixes.length === 0 || pathPrefixes.some((item) => typeof item !== "string" || !item.startsWith("/"))) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Target entry point and path allowlist must use absolute paths.");
  }
  if (!isRecord(value.inputs) || !isRecord(value.outputs) || !isRecord(value.policy) || !Array.isArray(value.steps)) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability contract sections are missing.");
  }
  const allowedActions = value.policy.allowedActions;
  const maxSteps = value.policy.maxSteps;
  const runTimeoutMs = value.policy.runTimeoutMs;
  const validActions = new Set(["type", "click", "wait_for_outcome", "extract"]);
  if (
    !Array.isArray(allowedActions)
    || allowedActions.length === 0
    || allowedActions.some((action) => typeof action !== "string" || !validActions.has(action))
    || !["read_only", "reversible", "irreversible"].includes(String(value.policy.risk))
    || typeof value.policy.requiresHumanApproval !== "boolean"
    || !Number.isInteger(maxSteps)
    || (typeof maxSteps === "number" && maxSteps <= 0)
    || !Number.isFinite(runTimeoutMs)
    || (typeof runTimeoutMs === "number" && runTimeoutMs <= 0)
  ) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability execution policy is invalid.");
  }

  for (const [name, rawSpec] of Object.entries(value.inputs)) {
    if (!name || !isRecord(rawSpec) || rawSpec.type !== "string" || typeof rawSpec.required !== "boolean" || (rawSpec.sensitive !== undefined && typeof rawSpec.sensitive !== "boolean") || (rawSpec.pattern !== undefined && typeof rawSpec.pattern !== "string")) {
      throw new AutomationError("artifact_invalid", "hard_failure", `Input ${name || "<unnamed>"} has an invalid type contract.`);
    }
    if (typeof rawSpec.pattern === "string") {
      try { new RegExp(rawSpec.pattern); } catch {
        throw new AutomationError("artifact_invalid", "hard_failure", `Input ${name} declares an invalid regular expression.`);
      }
    }
  }

  for (const [name, rawSpec] of Object.entries(value.outputs)) {
    if (!isRecord(rawSpec) || !["string", "currency"].includes(String(rawSpec.type))) {
      throw new AutomationError("artifact_invalid", "hard_failure", `Output ${name} has an invalid type contract.`);
    }
    if (rawSpec.type === "currency" && (typeof rawSpec.currency !== "string" || !/^[A-Z]{3}$/.test(rawSpec.currency))) {
      throw new AutomationError("artifact_invalid", "hard_failure", `Currency output ${name} must declare an ISO currency code.`);
    }
    if (rawSpec.allowedValues !== undefined && (!Array.isArray(rawSpec.allowedValues) || rawSpec.allowedValues.length === 0 || rawSpec.allowedValues.some((item) => typeof item !== "string" || item.length === 0))) {
      throw new AutomationError("artifact_invalid", "hard_failure", `Output ${name} has invalid allowed values.`);
    }
  }
  if (value.steps.length === 0 || typeof maxSteps !== "number" || value.steps.length > maxSteps) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability step count violates its execution policy.");
  }

  const stepIds = new Set<string>();
  const extractedOutputs = new Set<string>();
  if (!Array.isArray(value.businessOutcomes)) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability business outcomes must be an array.");
  }
  const businessCodes = new Set<string>();
  for (const outcome of value.businessOutcomes) {
    if (!isRecord(outcome) || typeof outcome.code !== "string" || !outcome.code || typeof outcome.message !== "string" || !outcome.message || typeof outcome.retryable !== "boolean" || businessCodes.has(outcome.code)) {
      throw new AutomationError("artifact_invalid", "hard_failure", "Every business outcome must declare a unique code, non-empty message, and retryable boolean.");
    }
    businessCodes.add(outcome.code);
  }

  for (const rawStep of value.steps) {
    if (!isRecord(rawStep) || typeof rawStep.id !== "string" || typeof rawStep.action !== "string") {
      throw new AutomationError("artifact_invalid", "hard_failure", "Every capability step needs an id and action.");
    }
    if (stepIds.has(rawStep.id)) throw new AutomationError("artifact_invalid", "hard_failure", `Duplicate step id: ${rawStep.id}.`);
    stepIds.add(rawStep.id);
    if (!allowedActions.includes(rawStep.action)) {
      throw new AutomationError("policy_denied", "policy_denied", `Action ${rawStep.action} is not allowlisted.`);
    }
    if (["type", "click", "extract"].includes(rawStep.action)) assertTarget(rawStep.target, `Step ${rawStep.id}`);
    if (rawStep.action === "type" && (typeof rawStep.input !== "string" || !Object.hasOwn(value.inputs, rawStep.input))) {
      throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} references an undeclared input.`);
    }
    if (rawStep.action === "extract") {
      if (typeof rawStep.output !== "string" || !Object.hasOwn(value.outputs, rawStep.output)) {
        throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} references an undeclared output.`);
      }
      extractedOutputs.add(rawStep.output);
    }
    if (rawStep.action === "wait_for_outcome") {
      if (!Array.isArray(rawStep.outcomes) || rawStep.outcomes.length < 2 || !Number.isFinite(rawStep.timeoutMs) || (typeof rawStep.timeoutMs === "number" && rawStep.timeoutMs <= 0)) {
        throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} must declare success and business outcomes.`);
      }
      let successOutcomes = 0;
      const stepBusinessCodes = new Set<string>();
      for (const outcome of rawStep.outcomes) {
        if (!isRecord(outcome) || !["success", "business_outcome"].includes(String(outcome.kind))) {
          throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} has an invalid outcome.`);
        }
        assertTarget(outcome.target, `Outcome in ${rawStep.id}`);
        if (outcome.kind === "success") successOutcomes += 1;
        if (outcome.kind === "business_outcome" && (typeof outcome.code !== "string" || !businessCodes.has(outcome.code))) {
          throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} references an undeclared business outcome.`);
        }
        if (outcome.kind === "business_outcome") {
          if (stepBusinessCodes.has(String(outcome.code))) throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} repeats business outcome ${outcome.code}.`);
          stepBusinessCodes.add(String(outcome.code));
        }
      }
      if (successOutcomes !== 1 || stepBusinessCodes.size === 0) throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} must declare exactly one success and at least one business outcome.`);
    }
  }

  for (const output of Object.keys(value.outputs)) {
    if (!extractedOutputs.has(output)) throw new AutomationError("artifact_invalid", "hard_failure", `Output ${output} is never extracted.`);
  }
  if (!isRecord(value.checkpoint) || value.checkpoint.kind !== "element_visible") {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability checkpoint is invalid.");
  }
  assertTarget(value.checkpoint.target, "Checkpoint");
  return value as Capability;
}

export function validateOutputValue(name: string, spec: OutputSpec, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AutomationError("output_missing", "hard_failure", `Declared output ${name} was empty.`);
  if (spec.type === "currency") {
    const currencyPattern = /^\$?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})$/;
    if (!currencyPattern.test(normalized)) {
      throw new AutomationError("output_type_invalid", "hard_failure", `Declared currency output ${name} did not match a monetary value.`);
    }
    const numeric = Number(normalized.replace(/[$,]/g, ""));
    if (!Number.isFinite(numeric)) throw new AutomationError("output_type_invalid", "hard_failure", `Declared currency output ${name} was not finite.`);
  }
  if (spec.allowedValues && !spec.allowedValues.includes(normalized)) {
    throw new AutomationError("output_value_invalid", "hard_failure", `Declared output ${name} was outside its allowed values.`);
  }
  return normalized;
}

function validateInputs(capability: Capability, inputs: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, spec] of Object.entries(capability.inputs)) {
    const value = inputs[name];
    if (spec.required && typeof value !== "string") {
      throw new AutomationError("invalid_input", "invalid_request", `Input ${name} is required.`);
    }
    if (typeof value !== "string") continue;
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      throw new AutomationError("invalid_input", "invalid_request", `Input ${name} does not match its declared format.`);
    }
    normalized[name] = value;
  }
  const unknown = Object.keys(inputs).find((name) => !Object.hasOwn(capability.inputs, name));
  if (unknown) throw new AutomationError("invalid_input", "invalid_request", `Input ${unknown} is not declared by this capability.`);
  return normalized;
}

export function isAllowedTargetUrl(rawUrl: string, origin: string, capability: Pick<Capability, "target">): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return false;
  }
  if (capability.target.allowlist.sameOrigin && url.origin !== origin) return false;
  return capability.target.allowlist.pathPrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

export async function executeCapability(options: {
  artifact: unknown;
  inputs: Record<string, unknown>;
  origin: string;
  adapter: SurfaceAdapter;
  runId?: string;
  now?: () => string;
  onEvidence?: (event: EvidenceEvent) => void;
  resume?: ReplayResume;
  humanActions?: HumanAction[];
}): Promise<ReplayResult> {
  let runId = options.runId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const evidence: EvidenceEvent[] = [];
  let activeStep = "initialize";
  let activeStepIndex = 0;
  let resumeOutputs: Record<string, string> = {};
  let resumeState: ReplayResumeState | null = null;
  let activeBinding: ReplayBinding | null = null;
  const deadline = Date.now() + 60_000;

  const record = (event: Omit<EvidenceEvent, "sequence" | "at">) => {
    const complete = { ...event, sequence: evidence.length + 1, at: now() };
    evidence.push(complete);
    options.onEvidence?.(complete);
  };

  try {
    if (options.resume) {
      if (typeof options.resume.token !== "string" || !options.resume.token) throw new AutomationError("resume_token_invalid", "policy_denied", "The replay resume token is missing or malformed.");
      try {
        resumeState = await verifyResumeState<ReplayResumeState>("automation-replay", options.resume.token);
      } catch {
        throw new AutomationError("resume_token_invalid", "policy_denied", "The replay resume token failed integrity or expiry validation.");
      }
      runId = resumeState.runId;
      activeStepIndex = resumeState.stepIndex;
      resumeOutputs = { ...resumeState.outputs };
      evidence.push(...resumeState.evidence);
    }
    const capability = validateCapability(options.artifact);
    const inputs = validateInputs(capability, options.inputs);
    const runDeadline = Date.now() + capability.policy.runTimeoutMs;
    const artifactFingerprint = await fingerprint(capability);
    const targetFingerprint = await fingerprint(capability.target);
    const inputFingerprint = await fingerprint(inputs);
    if (!isAllowedTargetUrl(capability.target.entryPoint, options.origin, capability)) {
      throw new AutomationError("policy_denied", "policy_denied", "Capability entry point is outside the target allowlist.");
    }
    if (capability.policy.risk === "irreversible" && !capability.policy.requiresHumanApproval) {
      throw new AutomationError("approval_required", "policy_denied", "Irreversible capabilities must require human approval.");
    }
    if (capability.policy.requiresHumanApproval || capability.policy.risk === "irreversible") {
      throw new AutomationError(
        "approval_required",
        "policy_denied",
        "Risky capabilities require an external human approval workflow and are not executed by this focused demo.",
      );
    }
    if (!resumeState) {
      record({ stepId: "policy", action: "policy_check", outcome: "ok", detail: "Artifact, inputs, action allowlist, risk policy, and target path approved." });
    } else {
      const sessionIdentity = options.adapter.sessionIdentity?.() ?? options.adapter.currentUrl();
      const expected = resumeState.binding;
      if (
        !expected
        || expected.artifactFingerprint !== artifactFingerprint
        || expected.targetFingerprint !== targetFingerprint
        || expected.inputFingerprint !== inputFingerprint
        || expected.origin !== options.origin
        || expected.sessionIdentity !== sessionIdentity
        || expected.stepIndex !== resumeState.stepIndex
      ) {
        throw new AutomationError("resume_context_mismatch", "policy_denied", "The resume token does not match the original artifact, inputs, target, session, or step.");
      }
      for (const action of options.humanActions ?? []) {
        record({ stepId: "handoff", action: "human_action", outcome: "ok", detail: `Human ${action.kind} on ${action.control}; values were not recorded.` });
      }
      record({ stepId: capability.steps[activeStepIndex]?.id ?? "checkpoint", action: "resume", outcome: "ok", detail: "Human returned control; target policy and live-session context revalidated." });
    }

    if (!resumeState) {
      await withOperationDeadline(
        (signal) => options.adapter.prepare(capability.target.entryPoint, signal),
        remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout."),
        "run_timeout",
        "Capability preparation exceeded its run timeout.",
      );
    }
    if (!isAllowedTargetUrl(options.adapter.currentUrl(), options.origin, capability)) {
      throw new AutomationError("policy_denied", "policy_denied", "Live surface navigated outside the target allowlist.");
    }
    activeBinding = {
      artifactFingerprint,
      targetFingerprint,
      inputFingerprint,
      origin: options.origin,
      sessionIdentity: options.adapter.sessionIdentity?.() ?? options.adapter.currentUrl(),
      stepIndex: activeStepIndex,
    };

    const outputs = resumeOutputs;
    for (const [name, value] of Object.entries(outputs)) {
      const spec = capability.outputs[name];
      if (!spec) throw new AutomationError("resume_context_mismatch", "policy_denied", `Resume token contains undeclared output ${name}.`);
      outputs[name] = validateOutputValue(name, spec, value);
    }
    for (let stepIndex = activeStepIndex; stepIndex < capability.steps.length; stepIndex += 1) {
      activeStepIndex = stepIndex;
      const step = capability.steps[stepIndex];
      activeStep = step.id;
      remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout.");
      activeBinding = { ...activeBinding, stepIndex };
      if (!capability.policy.allowedActions.includes(step.action)) {
        throw new AutomationError("policy_denied", "policy_denied", `Action ${step.action} is not allowlisted.`);
      }

      if (step.action === "type") {
        const locator = await withOperationDeadline((signal) => options.adapter.type(step.target, inputs[step.input], signal), remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout."), "run_timeout", `Step ${step.id} exceeded the run timeout.`);
        const sensitive = capability.inputs[step.input].sensitive;
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Entered ${sensitive ? "redacted " : ""}input ${step.input} using ${locator}.` });
      } else if (step.action === "click") {
        const locator = await withOperationDeadline((signal) => options.adapter.click(step.target, signal), remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout."), "run_timeout", `Step ${step.id} exceeded the run timeout.`);
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Activated ${step.target.description} using ${locator}.` });
      } else if (step.action === "wait_for_outcome") {
        const observed = await withOperationDeadline((signal) => options.adapter.waitForOutcome(step.outcomes, step.timeoutMs, signal), Math.min(step.timeoutMs, remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout.")), "outcome_timeout", `Step ${step.id} exceeded its outcome timeout.`);
        if (observed.kind === "business_outcome") {
          const definition = capability.businessOutcomes.find((item) => item.code === observed.code);
          if (!definition) throw new AutomationError("artifact_invalid", "hard_failure", `Business outcome ${observed.code} is undeclared.`);
          record({ stepId: step.id, action: step.action, outcome: "business_outcome", detail: `Detected declared ${definition.code} outcome.` });
          return { runId, status: "business_outcome", ...definition, evidence };
        }
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Observed ${observed.target.description}.` });
      } else {
        const extracted = await withOperationDeadline((signal) => options.adapter.extract(step.target, signal), remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout."), "run_timeout", `Step ${step.id} exceeded the run timeout.`);
        const value = typeof extracted === "string" ? extracted : extracted.value;
        const locator = typeof extracted === "string" ? null : extracted.locator;
        outputs[step.output] = validateOutputValue(step.output, capability.outputs[step.output], value);
        resumeOutputs = outputs;
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Extracted declared ${step.output} output${locator ? ` using ${locator}` : ""}.` });
      }

      if (!isAllowedTargetUrl(options.adapter.currentUrl(), options.origin, capability)) {
        throw new AutomationError("policy_denied", "policy_denied", `Step ${step.id} left the target allowlist.`);
      }
    }

    activeStep = "checkpoint";
    if (!(await withOperationDeadline((signal) => options.adapter.verify(capability.checkpoint.target, signal), remainingMs(runDeadline, "run_timeout", "Capability exceeded its run timeout."), "run_timeout", "Checkpoint verification exceeded the run timeout."))) {
      throw new AutomationError("checkpoint_failed", "hard_failure", "The declared success checkpoint was not satisfied.");
    }
    for (const output of Object.keys(capability.outputs)) {
      if (!outputs[output]) throw new AutomationError("output_missing", "hard_failure", `Declared output ${output} was not returned.`);
    }
    record({ stepId: "checkpoint", action: "checkpoint", outcome: "ok", detail: "Success checkpoint verified and all declared outputs returned." });
    return { runId, status: "success", outputs, evidence };
  } catch (error) {
    if (error instanceof HumanInterventionError) {
      record({ stepId: activeStep, action: "handoff", outcome: "intervention", detail: error.message });
      return {
        runId,
        status: "human_required",
        intervention: { code: error.code, message: error.message, stepId: activeStep, snapshot: error.snapshot },
        resume: { token: await signResumeState<ReplayResumeState>("automation-replay", {
          runId,
          stepIndex: activeStepIndex,
          outputs: resumeOutputs,
          evidence,
          binding: { ...(activeBinding ?? { artifactFingerprint: "", targetFingerprint: "", inputFingerprint: "", origin: options.origin, sessionIdentity: options.adapter.currentUrl(), stepIndex: activeStepIndex }), stepIndex: activeStepIndex },
        }) },
        evidence,
      };
    }
    const automationError = error instanceof AutomationError
      ? error
      : new AutomationError("unexpected_error", "hard_failure", error instanceof Error ? error.message : "Unknown replay error.");
    let snapshot: SurfaceSnapshot | undefined;
    if (options.adapter.snapshot) {
      try {
        snapshot = await withOperationDeadline((signal) => options.adapter.snapshot!(signal), Math.max(1, Math.min(1000, deadline - Date.now())), "snapshot_timeout", "Failure snapshot timed out.");
      } catch { /* Failure reporting must not replace the original error. */ }
    }
    record({ stepId: activeStep, action: "policy_check", outcome: "error", detail: automationError.message });
    return {
      runId,
      status: "failure",
      error: {
        category: automationError.category,
        code: automationError.code,
        stepId: activeStep,
        message: automationError.message,
        retryable: automationError.retryable,
        snapshot,
      },
      evidence,
    };
  }
}

export type RecoveryExecution = {
  result: ReplayResult;
  attempts: number;
  recovered: boolean;
};

async function replaceEvidence(result: ReplayResult, evidence: EvidenceEvent[]): Promise<ReplayResult> {
  if (result.status === "human_required") {
    const state = await verifyResumeState<ReplayResumeState>("automation-replay", result.resume.token);
    return { ...result, evidence, resume: { token: await signResumeState("automation-replay", { ...state, evidence }) } };
  }
  return { ...result, evidence };
}

export async function executeCapabilityWithRecovery(options: {
  artifact: unknown;
  inputs: Record<string, unknown>;
  origin: string;
  createAdapter(attempt: number): SurfaceAdapter;
  runId?: string;
  now?: () => string;
  onEvidence?: (event: EvidenceEvent) => void;
  maxAttempts?: number;
  retryableCodes?: string[];
}): Promise<RecoveryExecution> {
  const runId = options.runId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
  const retryableCodes = new Set(options.retryableCodes ?? ["session_expired", "outcome_timeout", "target_timeout", "run_timeout"]);
  const accumulated: EvidenceEvent[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeCapability({
      artifact: options.artifact,
      inputs: options.inputs,
      origin: options.origin,
      adapter: options.createAdapter(attempt),
      runId,
      now,
      onEvidence: options.onEvidence,
    });
    accumulated.push(...result.evidence.map((event) => ({ ...event, sequence: accumulated.length + event.sequence })));
    const shouldRetry = result.status === "failure"
      && result.error.retryable
      && retryableCodes.has(result.error.code)
      && attempt < maxAttempts;
    if (!shouldRetry) return { result: await replaceEvidence(result, accumulated), attempts: attempt, recovered: attempt > 1 && result.status !== "failure" };

    const recovery: EvidenceEvent = {
      sequence: accumulated.length + 1,
      at: now(),
      stepId: "recovery",
      action: "recovery",
      outcome: "ok",
      detail: `Bounded recovery approved after ${result.error.code}; restarting the allowlisted session for one deterministic retry.`,
    };
    accumulated.push(recovery);
    options.onEvidence?.(recovery);
  }

  throw new Error("Recovery loop terminated unexpectedly.");
}
