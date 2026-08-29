import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AutomationError, executeCapability, executeCapabilityWithRecovery, HumanInterventionError } from "../lib/automation/core.ts";
import { sha256Fingerprint } from "../lib/security/fingerprint.ts";

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

test("risky execution requires a completed fingerprint-bound approval grant", async () => {
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

  const insufficient = await executeCapability({
    artifact: riskyArtifact,
    inputs: { memberId: "12345" },
    adapter: adapter(),
    approvalGrant: { artifactHash: await sha256Fingerprint(riskyArtifact), state: "approved", approvals: 1, requiredApprovals: 1, rejections: 0, approvedAt: fixed.now() },
    ...fixed,
  });
  assert.equal(insufficient.status, "failure");
  assert.equal(insufficient.error.code, "approval_required");

  const mismatched = await executeCapability({
    artifact: riskyArtifact,
    inputs: { memberId: "12345" },
    adapter: adapter(),
    approvalGrant: { artifactHash: "wrong", state: "approved", approvals: 2, requiredApprovals: 2, rejections: 0, approvedAt: fixed.now() },
    ...fixed,
  });
  assert.equal(mismatched.status, "failure");
  assert.equal(mismatched.error.code, "approval_fingerprint_mismatch");

  const approved = await executeCapability({
    artifact: riskyArtifact,
    inputs: { memberId: "12345" },
    adapter: adapter(),
    approvalGrant: {
      artifactHash: await sha256Fingerprint(riskyArtifact),
      state: "approved",
      approvals: 2,
      requiredApprovals: 2,
      rejections: 0,
      approvedAt: fixed.now(),
    },
    ...fixed,
  });
  assert.equal(approved.status, "success");
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
