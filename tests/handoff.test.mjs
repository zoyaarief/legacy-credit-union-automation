import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_HANDOFF_STATE, transitionHandoff } from "../lib/handoff/core.ts";
import { capabilityFingerprint, sanitizeRunRecord, sha256 } from "../lib/persistence/contracts.ts";
import { readFile } from "node:fs/promises";

const artifactUrl = new URL("../capabilities/get-savings-balance.v1.json", import.meta.url);

test("handoff ownership follows request, accept, human action, resume, and complete", () => {
  let state = transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: "run-1" });
  assert.equal(state.owner, "human_requested");
  state = transitionHandoff(state, { type: "accept" });
  state = transitionHandoff(state, { type: "record", action: { at: "2026-08-27T12:00:00.000Z", kind: "click", control: "Continue lookup for 31415" } });
  assert.equal(state.actions[0].control.includes("31415"), false);
  state = transitionHandoff(state, { type: "resume" });
  assert.equal(state.owner, "resuming");
  state = transitionHandoff(state, { type: "complete" });
  assert.equal(state.owner, "completed");
});

test("handoff rejects invalid ownership transitions", () => {
  assert.throws(() => transitionHandoff(INITIAL_HANDOFF_STATE, { type: "resume" }), /Invalid handoff transition/);
});

test("durable run records redact sensitive values before storage", () => {
  const record = sanitizeRunRecord({
    runId: "run-1",
    kind: "handoff",
    status: "success",
    artifactName: "get_savings_balance",
    artifactVersion: "1.0.0",
    summary: { note: "Handled member 31415" },
    evidence: [{ sequence: 1, at: "2026-08-27T12:00:00.000Z", stepId: "handoff", action: "human_action", outcome: "ok", detail: "Clicked for 31415" }],
  });
  assert.equal(JSON.stringify(record).includes("31415"), false);
  assert.ok(JSON.stringify(record).includes("[REDACTED_ID]"));
  assert.equal(record.retentionDays, 30);
});

test("retention is restricted to the supported policy windows", () => {
  const base = {
    runId: "run-retention", kind: "replay", status: "success",
    artifactName: "get_savings_balance", artifactVersion: "1.0.0", summary: {}, evidence: [],
  };
  assert.equal(sanitizeRunRecord({ ...base, retentionDays: 7 }).retentionDays, 7);
  assert.equal(sanitizeRunRecord({ ...base, retentionDays: 365 }).retentionDays, 30);
});

test("evidence hashes are deterministic and tamper evident", async () => {
  const evidence = [{ sequence: 1, outcome: "ok", detail: "policy approved" }];
  const first = await sha256(evidence);
  assert.equal(first, await sha256(structuredClone(evidence)));
  assert.notEqual(first, await sha256([{ ...evidence[0], outcome: "error" }]));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("artifact approval fingerprints bind to the exact capability", async () => {
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
  const approved = await capabilityFingerprint(artifact);
  const modified = structuredClone(artifact);
  modified.description = `${modified.description} changed`;
  assert.notEqual(approved, await capabilityFingerprint(modified));
});
