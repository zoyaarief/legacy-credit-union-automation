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
  action: "policy_check" | "checkpoint" | CapabilityStep["action"];
  outcome: "ok" | "business_outcome" | "error";
  detail: string;
};

export type FailureCategory = "invalid_request" | "policy_denied" | "recoverable" | "hard_failure";

export type ReplayResult =
  | { runId: string; status: "success"; outputs: Record<string, string>; evidence: EvidenceEvent[] }
  | { runId: string; status: "business_outcome"; code: string; message: string; retryable: boolean; evidence: EvidenceEvent[] }
  | {
      runId: string;
      status: "failure";
      error: { category: FailureCategory; code: string; stepId: string; message: string; retryable: boolean };
      evidence: EvidenceEvent[];
    };

export type SurfaceAdapter = {
  prepare(entryPoint: string): Promise<void>;
  currentUrl(): string;
  type(target: ControlTarget, value: string): Promise<string>;
  click(target: ControlTarget): Promise<string>;
  waitForOutcome(outcomes: OutcomeDefinition[], timeoutMs: number): Promise<OutcomeDefinition>;
  extract(target: ControlTarget): Promise<string>;
  verify(target: ControlTarget): Promise<boolean>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(value) || value.schemaVersion !== "1.0" || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability identity or schema version is invalid.");
  }
  if (!isRecord(value.target) || value.target.surface !== "web" || typeof value.target.entryPoint !== "string" || !isRecord(value.target.allowlist)) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability target policy is invalid.");
  }
  const pathPrefixes = value.target.allowlist.pathPrefixes;
  if (!value.target.entryPoint.startsWith("/") || !Array.isArray(pathPrefixes) || pathPrefixes.some((item) => typeof item !== "string" || !item.startsWith("/"))) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Target entry point and path allowlist must use absolute paths.");
  }
  if (!isRecord(value.inputs) || !isRecord(value.outputs) || !isRecord(value.policy) || !Array.isArray(value.steps)) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability contract sections are missing.");
  }
  const allowedActions = value.policy.allowedActions;
  if (!Array.isArray(allowedActions) || typeof value.policy.maxSteps !== "number" || typeof value.policy.runTimeoutMs !== "number") {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability execution policy is invalid.");
  }
  if (value.steps.length === 0 || value.steps.length > value.policy.maxSteps) {
    throw new AutomationError("artifact_invalid", "hard_failure", "Capability step count violates its execution policy.");
  }

  const stepIds = new Set<string>();
  const extractedOutputs = new Set<string>();
  const businessCodes = new Set(
    Array.isArray(value.businessOutcomes)
      ? value.businessOutcomes.filter(isRecord).map((item) => String(item.code))
      : [],
  );

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
      if (!Array.isArray(rawStep.outcomes) || rawStep.outcomes.length < 2 || typeof rawStep.timeoutMs !== "number") {
        throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} must declare success and business outcomes.`);
      }
      for (const outcome of rawStep.outcomes) {
        if (!isRecord(outcome) || !["success", "business_outcome"].includes(String(outcome.kind))) {
          throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} has an invalid outcome.`);
        }
        assertTarget(outcome.target, `Outcome in ${rawStep.id}`);
        if (outcome.kind === "business_outcome" && (typeof outcome.code !== "string" || !businessCodes.has(outcome.code))) {
          throw new AutomationError("artifact_invalid", "hard_failure", `Step ${rawStep.id} references an undeclared business outcome.`);
        }
      }
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

export function isAllowedTargetUrl(rawUrl: string, origin: string, capability: Capability): boolean {
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
}): Promise<ReplayResult> {
  const runId = options.runId ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date().toISOString());
  const evidence: EvidenceEvent[] = [];
  let activeStep = "initialize";

  const record = (event: Omit<EvidenceEvent, "sequence" | "at">) => {
    const complete = { ...event, sequence: evidence.length + 1, at: now() };
    evidence.push(complete);
    options.onEvidence?.(complete);
  };

  try {
    const capability = validateCapability(options.artifact);
    const inputs = validateInputs(capability, options.inputs);
    if (!isAllowedTargetUrl(capability.target.entryPoint, options.origin, capability)) {
      throw new AutomationError("policy_denied", "policy_denied", "Capability entry point is outside the target allowlist.");
    }
    if (capability.policy.risk === "irreversible" && !capability.policy.requiresHumanApproval) {
      throw new AutomationError("approval_required", "policy_denied", "Irreversible capabilities must require human approval.");
    }
    record({ stepId: "policy", action: "policy_check", outcome: "ok", detail: "Artifact, inputs, action allowlist, risk policy, and target path approved." });

    const startedAt = Date.now();
    await options.adapter.prepare(capability.target.entryPoint);
    if (!isAllowedTargetUrl(options.adapter.currentUrl(), options.origin, capability)) {
      throw new AutomationError("policy_denied", "policy_denied", "Live surface navigated outside the target allowlist.");
    }

    const outputs: Record<string, string> = {};
    for (const step of capability.steps) {
      activeStep = step.id;
      if (Date.now() - startedAt > capability.policy.runTimeoutMs) {
        throw new AutomationError("run_timeout", "recoverable", "Capability exceeded its run timeout.", true);
      }
      if (!capability.policy.allowedActions.includes(step.action)) {
        throw new AutomationError("policy_denied", "policy_denied", `Action ${step.action} is not allowlisted.`);
      }

      if (step.action === "type") {
        const locator = await options.adapter.type(step.target, inputs[step.input]);
        const sensitive = capability.inputs[step.input].sensitive;
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Entered ${sensitive ? "redacted " : ""}input ${step.input} using ${locator}.` });
      } else if (step.action === "click") {
        const locator = await options.adapter.click(step.target);
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Activated ${step.target.description} using ${locator}.` });
      } else if (step.action === "wait_for_outcome") {
        const observed = await options.adapter.waitForOutcome(step.outcomes, step.timeoutMs);
        if (observed.kind === "business_outcome") {
          const definition = capability.businessOutcomes.find((item) => item.code === observed.code);
          if (!definition) throw new AutomationError("artifact_invalid", "hard_failure", `Business outcome ${observed.code} is undeclared.`);
          record({ stepId: step.id, action: step.action, outcome: "business_outcome", detail: `Detected declared ${definition.code} outcome.` });
          return { runId, status: "business_outcome", ...definition, evidence };
        }
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Observed ${observed.target.description}.` });
      } else {
        const value = await options.adapter.extract(step.target);
        if (!value) throw new AutomationError("output_missing", "hard_failure", `Declared output ${step.output} was empty.`);
        outputs[step.output] = value;
        record({ stepId: step.id, action: step.action, outcome: "ok", detail: `Extracted declared ${step.output} output.` });
      }

      if (!isAllowedTargetUrl(options.adapter.currentUrl(), options.origin, capability)) {
        throw new AutomationError("policy_denied", "policy_denied", `Step ${step.id} left the target allowlist.`);
      }
    }

    activeStep = "checkpoint";
    if (!(await options.adapter.verify(capability.checkpoint.target))) {
      throw new AutomationError("checkpoint_failed", "hard_failure", "The declared success checkpoint was not satisfied.");
    }
    for (const output of Object.keys(capability.outputs)) {
      if (!outputs[output]) throw new AutomationError("output_missing", "hard_failure", `Declared output ${output} was not returned.`);
    }
    record({ stepId: "checkpoint", action: "checkpoint", outcome: "ok", detail: "Success checkpoint verified and all declared outputs returned." });
    return { runId, status: "success", outputs, evidence };
  } catch (error) {
    const automationError = error instanceof AutomationError
      ? error
      : new AutomationError("unexpected_error", "hard_failure", error instanceof Error ? error.message : "Unknown replay error.");
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
      },
      evidence,
    };
  }
}
