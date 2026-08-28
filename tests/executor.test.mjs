import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeCapability } from "../lib/automation/core.ts";

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
