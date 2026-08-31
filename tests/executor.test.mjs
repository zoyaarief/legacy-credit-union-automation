import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AutomationError, executeCapability, executeCapabilityWithRecovery, HumanInterventionError, validateCapability } from "../lib/automation/core.ts";

const artifactUrl = new URL("../capabilities/get-savings-balance.v1.json", import.meta.url);
const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));

function adapter(overrides = {}) {
  return {
    async prepare() {},
    currentUrl: () => "http://localhost:3000/legacy",
    type: async () => "name:member_number",
    click: async () => "button_text:Retrieve Record",
    waitForOutcome: async (outcomes) => outcomes.find((outcome) => outcome.kind === "success"),
    extract: async (target) => target.description.includes("balance") ? "$2,458.17" : "Active",
    verify: async () => true,
    ...overrides,
  };
}

const fixed = {
  origin: "http://localhost:3000",
  runId: "run-test",
  now: () => "2026-08-27T12:00:00.000Z",
};

test("executor returns declared outputs and verifies the checkpoint", async () => {
  const result = await executeCapability({ artifact, inputs: { memberId: "12345" }, adapter: adapter(), ...fixed });

  assert.equal(result.status, "success");
  assert.deepEqual(result.outputs, { balance: "$2,458.17", accountStatus: "Active" });
  assert.equal(result.evidence.at(-1).stepId, "checkpoint");
  assert.equal(JSON.stringify(result.evidence).includes("12345"), false);
});

test("executor records the successful locator used for extraction", async () => {
  const result = await executeCapability({
    artifact,
    inputs: { memberId: "12345" },
    adapter: adapter({ extract: async (target) => ({ value: target.description.includes("balance") ? "$2,458.17" : "Active", locator: "css:.verified-output" }) }),
    ...fixed,
  });

  assert.equal(result.status, "success");
  assert.ok(result.evidence.some((event) => event.action === "extract" && event.detail.includes("css:.verified-output")));
});

test("risky execution is blocked before the live surface is touched", async () => {
  const riskyArtifact = structuredClone(artifact);
  riskyArtifact.policy.risk = "irreversible";
  riskyArtifact.policy.requiresHumanApproval = true;
  let prepared = false;
  const denied = await executeCapability({
    artifact: riskyArtifact,
    inputs: { memberId: "12345" },
    adapter: adapter({ prepare: async () => { prepared = true; } }),
    ...fixed,
  });
  assert.equal(denied.status, "failure");
  assert.equal(denied.error.code, "approval_required");
  assert.equal(prepared, false);
});

test("artifact policy validation fails closed for unknown risk and approval values", () => {
  const unknownRisk = structuredClone(artifact);
  unknownRisk.policy.risk = "invented_high_risk";
  assert.throws(() => validateCapability(unknownRisk), /execution policy is invalid/);
  const invalidApproval = structuredClone(artifact);
  invalidApproval.policy.requiresHumanApproval = "no";
  assert.throws(() => validateCapability(invalidApproval), /execution policy is invalid/);
});

test("artifact validation rejects malformed input, wait, and business-outcome contracts", () => {
  for (const invalidInput of [null, { type: "number", required: true }, { type: "string", required: "yes" }, { type: "string", required: true, sensitive: "yes" }, { type: "string", required: true, pattern: "[" }]) {
    const malformed = structuredClone(artifact);
    malformed.inputs.memberId = invalidInput;
    assert.throws(() => validateCapability(malformed), (error) => error.code === "artifact_invalid");
  }
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const malformed = structuredClone(artifact);
    malformed.steps.find((step) => step.action === "wait_for_outcome").timeoutMs = timeoutMs;
    assert.throws(() => validateCapability(malformed), (error) => error.code === "artifact_invalid");
  }
  for (const invalidOutcome of [null, { code: "member_not_found", message: "Missing" }, { code: "member_not_found", message: "", retryable: false }, { code: 4, message: "Missing", retryable: false }]) {
    const malformed = structuredClone(artifact);
    malformed.businessOutcomes = [invalidOutcome];
    assert.throws(() => validateCapability(malformed), (error) => error.code === "artifact_invalid");
  }
});

test("malformed input definitions fail execution as artifact_invalid", async () => {
  const malformed = structuredClone(artifact);
  malformed.inputs.memberId = null;
  const result = await executeCapability({ artifact: malformed, inputs: { memberId: "12345" }, adapter: adapter(), ...fixed });
  assert.equal(result.status, "failure");
  assert.equal(result.error.code, "artifact_invalid");
});

test("executor enforces declared currency and status output values", async () => {
  const invalidCurrency = await executeCapability({ artifact, inputs: { memberId: "12345" }, adapter: adapter({ extract: async (target) => target.description.includes("balance") ? "08/21/2026" : "Active" }), ...fixed });
  assert.equal(invalidCurrency.status, "failure");
  assert.equal(invalidCurrency.error.code, "output_type_invalid");
  const invalidStatus = await executeCapability({ artifact, inputs: { memberId: "12345" }, adapter: adapter({ extract: async (target) => target.description.includes("balance") ? "$2,458.17" : "Unknownish" }), ...fixed });
  assert.equal(invalidStatus.status, "failure");
  assert.equal(invalidStatus.error.code, "output_value_invalid");
});

test("executor returns a known business outcome without treating it as a crash", async () => {
  const result = await executeCapability({
    artifact,
    inputs: { memberId: "00000" },
    adapter: adapter({ waitForOutcome: async (outcomes) => outcomes.find((outcome) => outcome.kind === "business_outcome") }),
    ...fixed,
  });

  assert.equal(result.status, "business_outcome");
  assert.equal(result.code, "member_not_found");
  assert.equal(result.retryable, false);
});

test("executor rejects malformed inputs before touching the live surface", async () => {
  let prepared = false;
  const result = await executeCapability({
    artifact,
    inputs: { memberId: "abc" },
    adapter: adapter({ prepare: async () => { prepared = true; } }),
    ...fixed,
  });

  assert.equal(result.status, "failure");
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.code, "invalid_input");
  assert.equal(prepared, false);
});

test("executor blocks a capability entry point outside its path allowlist", async () => {
  const unsafeArtifact = structuredClone(artifact);
  unsafeArtifact.target.entryPoint = "/admin";
  const result = await executeCapability({ artifact: unsafeArtifact, inputs: { memberId: "12345" }, adapter: adapter(), ...fixed });

  assert.equal(result.status, "failure");
  assert.equal(result.error.category, "policy_denied");
  assert.equal(result.error.code, "policy_denied");
});

test("executor reports a missing checkpoint as a hard failure", async () => {
  const result = await executeCapability({
    artifact,
    inputs: { memberId: "12345" },
    adapter: adapter({ verify: async () => false }),
    ...fixed,
  });

  assert.equal(result.status, "failure");
  assert.equal(result.error.code, "checkpoint_failed");
  assert.equal(result.error.stepId, "checkpoint");
});

test("executor pauses for a human and resumes the same prepared session", async () => {
  let prepared = 0;
  let blocked = true;
  const liveAdapter = adapter({
    prepare: async () => { prepared += 1; },
    waitForOutcome: async (outcomes) => {
      if (blocked) {
        throw new HumanInterventionError(
          "operator_acknowledgment_required",
          "Operator acknowledgment required.",
          { surface: "web", path: "/legacy", title: "Northstar", visibleSignals: ["permission_dialog"] },
        );
      }
      return outcomes.find((outcome) => outcome.kind === "success");
    },
  });
  const paused = await executeCapability({ artifact, inputs: { memberId: "31415" }, adapter: liveAdapter, ...fixed });
  assert.equal(paused.status, "human_required");
  assert.equal(paused.intervention.stepId, "wait_for_member_outcome");
  assert.equal(prepared, 1);

  blocked = false;
  const resumed = await executeCapability({
    artifact,
    inputs: { memberId: "31415" },
    adapter: liveAdapter,
    resume: paused.resume,
    humanActions: [{ at: fixed.now(), kind: "click", control: "Continue lookup" }],
    ...fixed,
  });
  assert.equal(resumed.status, "success");
  assert.equal(prepared, 1);
  assert.ok(resumed.evidence.some((event) => event.action === "human_action"));
  assert.ok(resumed.evidence.some((event) => event.action === "resume"));
  assert.equal(JSON.stringify(resumed.evidence).includes("31415"), false);
});

test("executor rejects a resume with different invocation inputs", async () => {
  let blocked = true;
  const liveAdapter = adapter({
    waitForOutcome: async (outcomes) => {
      if (blocked) throw new HumanInterventionError("operator_acknowledgment_required", "Operator acknowledgment required.", { surface: "web", path: "/legacy", title: "Northstar", visibleSignals: ["permission_dialog"] });
      return outcomes.find((outcome) => outcome.kind === "success");
    },
  });
  const paused = await executeCapability({ artifact, inputs: { memberId: "31415" }, adapter: liveAdapter, ...fixed });
  assert.equal(paused.status, "human_required");
  blocked = false;
  const resumed = await executeCapability({ artifact, inputs: { memberId: "12345" }, adapter: liveAdapter, resume: paused.resume, ...fixed });
  assert.equal(resumed.status, "failure");
  assert.equal(resumed.error.code, "resume_context_mismatch");
});

test("executor rejects a client-modified resume token", async () => {
  const liveAdapter = adapter({
    waitForOutcome: async () => { throw new HumanInterventionError("operator_acknowledgment_required", "Operator acknowledgment required.", { surface: "web", path: "/legacy", title: "Northstar", visibleSignals: ["permission_dialog"] }); },
  });
  const paused = await executeCapability({ artifact, inputs: { memberId: "31415" }, adapter: liveAdapter, ...fixed });
  assert.equal(paused.status, "human_required");
  const final = paused.resume.token.at(-1);
  const forged = { token: `${paused.resume.token.slice(0, -1)}${final === "A" ? "B" : "A"}` };
  const resumed = await executeCapability({ artifact, inputs: { memberId: "31415" }, adapter: liveAdapter, resume: forged, ...fixed });
  assert.equal(resumed.status, "failure");
  assert.equal(resumed.error.code, "resume_token_invalid");
});

test("declared run timeout aborts the underlying adapter call", async () => {
  const short = structuredClone(artifact);
  short.policy.runTimeoutMs = 20;
  let aborted = false;
  let mutated = false;
  const result = await executeCapability({
    artifact: short,
    inputs: { memberId: "12345" },
    adapter: adapter({
      type: async (_target, _value, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { mutated = true; resolve("late mutation"); }, 80);
        signal.addEventListener("abort", () => { clearTimeout(timer); aborted = true; reject(signal.reason); }, { once: true });
      }),
    }),
    ...fixed,
  });
  assert.equal(result.status, "failure");
  assert.equal(result.error.code, "run_timeout");
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(aborted, true);
  assert.equal(mutated, false);
});

for (const fault of [
  { code: "session_expired", category: "recoverable", retryable: true },
  { code: "outcome_timeout", category: "recoverable", retryable: true },
  { code: "application_unavailable", category: "hard_failure", retryable: false },
]) {
  test(`executor preserves the ${fault.code} fault classification`, async () => {
    const result = await executeCapability({
      artifact,
      inputs: { memberId: "12345" },
      adapter: adapter({
        waitForOutcome: async () => {
          throw new AutomationError(fault.code, fault.category, "Injected fault.", fault.retryable);
        },
      }),
      ...fixed,
    });
    assert.equal(result.status, "failure");
    assert.equal(result.error.code, fault.code);
    assert.equal(result.error.category, fault.category);
    assert.equal(result.error.retryable, fault.retryable);
  });
}

test("bounded recovery restarts one retryable replay and preserves evidence", async () => {
  const execution = await executeCapabilityWithRecovery({
    artifact,
    inputs: { memberId: "12345" },
    origin: fixed.origin,
    runId: fixed.runId,
    now: fixed.now,
    createAdapter: (attempt) => adapter({
      waitForOutcome: async (outcomes) => {
        if (attempt === 1) throw new AutomationError("session_expired", "recoverable", "Session expired.", true);
        return outcomes.find((outcome) => outcome.kind === "success");
      },
    }),
  });
  assert.equal(execution.result.status, "success");
  assert.equal(execution.attempts, 2);
  assert.equal(execution.recovered, true);
  assert.ok(execution.result.evidence.some((event) => event.action === "recovery"));
  assert.deepEqual(execution.result.evidence.map((event) => event.sequence), execution.result.evidence.map((_, index) => index + 1));
});

test("bounded recovery never retries a hard failure", async () => {
  let adapters = 0;
  const execution = await executeCapabilityWithRecovery({
    artifact,
    inputs: { memberId: "12345" },
    origin: fixed.origin,
    runId: fixed.runId,
    now: fixed.now,
    createAdapter: () => {
      adapters += 1;
      return adapter({ waitForOutcome: async () => { throw new AutomationError("application_unavailable", "hard_failure", "Unavailable."); } });
    },
  });
  assert.equal(execution.result.status, "failure");
  assert.equal(execution.attempts, 1);
  assert.equal(adapters, 1);
});
