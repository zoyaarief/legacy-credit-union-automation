import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_HANDOFF_STATE, transitionHandoff } from "../lib/handoff/core.ts";
import { sanitizeRunRecord } from "../lib/persistence/contracts.ts";

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
});
