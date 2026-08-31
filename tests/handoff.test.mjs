import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_HANDOFF_STATE, terminalResumeEvent, transitionHandoff } from "../lib/handoff/core.ts";

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

test("handoff can re-request human control or fail safely after resume", () => {
  let state = transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: "run-2" });
  state = transitionHandoff(state, { type: "accept" });
  state = transitionHandoff(state, { type: "resume" });
  state = transitionHandoff(state, { type: "request", interventionId: "run-2-again" });
  assert.equal(state.owner, "human_requested");

  state = transitionHandoff(state, { type: "accept" });
  state = transitionHandoff(state, { type: "resume" });
  state = transitionHandoff(state, { type: "fail" });
  assert.equal(state.owner, "failed");
});

test("resumed discovery maps failures to failed ownership instead of completed", () => {
  let state = transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: "discovery-failure" });
  state = transitionHandoff(state, { type: "accept" });
  state = transitionHandoff(state, { type: "resume" });
  state = transitionHandoff(state, terminalResumeEvent("failure"));
  assert.equal(state.owner, "failed");
  assert.deepEqual(terminalResumeEvent("success"), { type: "complete" });
  assert.deepEqual(terminalResumeEvent("business_outcome"), { type: "complete" });
});
