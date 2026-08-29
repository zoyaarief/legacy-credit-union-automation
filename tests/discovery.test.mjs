import assert from "node:assert/strict";
import test from "node:test";
import {
  compileDiscoveredCapability,
  createSimulatedDiscoveryProvider,
  redactDiscoveryText,
  runDiscovery,
  validateSupportedDiscoveryGoal,
  validateDiscoveryDecision,
} from "../lib/discovery/core.ts";
import { decideWithOpenAI } from "../lib/discovery/openai.ts";
import { createAdaptiveDiscoveryProvider } from "../lib/discovery/provider-client.ts";

const locator = (kind, value) => ({ kind, value });

function discoveryAdapter({ notFound = false, humanRequired = false, variant = "main" } = {}) {
  let state = "form";
  let filled = false;
  let blocked = humanRequired;
  let prepareCount = 0;
  const east = variant === "east";
  const fieldLocators = east
    ? [locator("name", "member_key_east"), locator("css", ".east-member-query input")]
    : [locator("name", "member_number"), locator("css", "#member-number")];
  const buttonLocators = east
    ? [locator("button_text", "Search Accounts"), locator("css", ".east-member-query button:nth-of-type(2)")]
    : [locator("button_text", "Retrieve Record"), locator("css", "#retrieve-record")];
  const summaryLocators = east
    ? [locator("css", ".east-account-result"), locator("css", "main > section:nth-of-type(3)")]
    : [locator("css", "#member-summary"), locator("css", ".member-result")];
  const balanceLocators = east
    ? [locator("css", ".east-balance-cell"), locator("css", ".east-grid td:nth-of-type(3)")]
    : [locator("css", ".savings-balance"), locator("css", ".accounts-grid td:nth-of-type(3)")];
  const statusLocators = east
    ? [locator("css", ".east-state-cell"), locator("css", ".east-grid td:nth-of-type(4)")]
    : [locator("css", ".account-status"), locator("css", ".accounts-grid td:nth-of-type(4)")];

  const formControls = () => {
    const useful = [
      { ref: east ? "surface-92" : "surface-1", role: "textbox", name: east ? "Member ID" : "Member Number", context: "Account inquiry form", visible: true, enabled: true, filled, locatorCandidates: fieldLocators },
      { ref: east ? "surface-17" : "surface-2", role: "button", name: east ? "Search Accounts" : "Retrieve Record", context: "Account inquiry form", visible: true, enabled: true, locatorCandidates: buttonLocators },
    ];
    const distractors = [
      { ref: "surface-extra-a", role: "combobox", name: "Branch", context: "Navigation filter", visible: true, enabled: true, locatorCandidates: [locator("name", "branch"), locator("css", "select:first-of-type")] },
      { ref: "surface-extra-b", role: "button", name: "Clear", context: "Reset the form", visible: true, enabled: true, locatorCandidates: [locator("button_text", "Clear"), locator("css", "button.clear-form")] },
    ];
    return east ? [distractors[0], useful[1], distractors[1], useful[0]] : [...useful, ...distractors];
  };

  return {
    async prepare() { prepareCount += 1; state = "form"; filled = false; },
    currentUrl: () => "http://localhost:3000/legacy",
    async observe() {
      const resultControls = state === "summary"
        ? [
            { ref: "result-surface", role: "region", name: "Member account summary", context: "Lookup result", visible: true, locatorCandidates: summaryLocators },
            { ref: "cell-balance", role: "text", name: "Current Balance cell", context: "Account row: REGULAR SAVINGS", visible: true, hasValue: true, locatorCandidates: balanceLocators },
            { ref: "cell-status", role: "text", name: "Status cell", context: "Account row: REGULAR SAVINGS", visible: true, hasValue: true, locatorCandidates: statusLocators },
          ]
        : state === "notfound"
          ? [{ ref: "status-none", role: "status", name: "Member not found", context: "No member matched", visible: true, locatorCandidates: [locator("css", ".no-result"), locator("css", "[role=status]")] }]
          : state === "dialog"
            ? [{ ref: "interrupt-7", role: "dialog", name: "Restricted account acknowledgment", context: "Operator authorization required", visible: true, locatorCandidates: [locator("css", ".permission-dialog"), locator("css", "[role=dialog]")] }]
            : [];
      return { url: "http://localhost:3000/legacy", title: "Northstar Member Services", controls: [...formControls(), ...resultControls] };
    },
    async execute(decision, inputs) {
      if (decision.action === "type") { filled = Boolean(inputs.memberId); return { locator: `${decision.target.locators[0].kind}:${decision.target.locators[0].value}` }; }
      if (decision.action === "click") { state = "loading"; return { locator: `${decision.target.locators[0].kind}:${decision.target.locators[0].value}` }; }
      if (decision.action === "wait_for_change") { state = blocked ? "dialog" : notFound ? "notfound" : "summary"; return {}; }
      if (decision.action === "extract") return { value: decision.output === "balance" ? "$2,458.17" : "Active", locator: `${decision.target.locators[0].kind}:${decision.target.locators[0].value}` };
      throw new Error(`Unexpected adapter action ${decision.action}`);
    },
    async verify(target) { return state === "summary" && target.locators.some((item) => summaryLocators.some((expected) => expected.kind === item.kind && expected.value === item.value)); },
    acknowledge() { blocked = false; state = "summary"; },
    preparations() { return prepareCount; },
    expectedLocators: { fieldLocators, buttonLocators, summaryLocators, balanceLocators, statusLocators },
  };
}

const fixed = {
  goal: "Look up member {{memberId}} and return the savings balance and account status.",
  inputs: { memberId: "12345" },
  origin: "http://localhost:3000",
  runId: "discovery-test",
  now: () => "2026-08-27T12:00:00.000Z",
};

const contextWith = (controls, history = []) => ({
  goal: fixed.goal,
  step: history.length + 1,
  maxSteps: 8,
  inputContract: { memberId: { type: "string", sensitive: true } },
  outputContract: { balance: { type: "currency" }, accountStatus: { type: "string" } },
  observation: { url: "http://localhost:3000/legacy", title: "Northstar", controls },
  history,
});

const rawDecision = (overrides = {}) => ({
  action: "wait_for_change",
  controlRef: null,
  locators: [],
  input: null,
  output: null,
  businessCode: null,
  interventionCode: null,
  reason: "Wait for a surface change.",
  capabilityName: null,
  ...overrides,
});

test("goal-driven discovery observes controls and compiles a replayable artifact", async () => {
  const result = await runDiscovery({ ...fixed, provider: createSimulatedDiscoveryProvider(), adapter: discoveryAdapter() });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.provider, "safe-simulator");
  assert.deepEqual(result.outputs, { balance: "$2,458.17", accountStatus: "Active" });
  assert.equal(result.artifact.name, "get_savings_balance");
  assert.equal(result.artifact.version, "1.2.0");
  assert.equal(result.artifact.steps.length, 5);
  assert.equal(result.evidence.at(-1).phase, "complete");
  assert.equal(JSON.stringify(result).includes("12345"), false);
});

test("discovery adapts to reordered controls, renamed refs, and different live locators", async () => {
  const adapter = discoveryAdapter({ variant: "east" });
  const result = await runDiscovery({ ...fixed, runId: "east-discovery", provider: createSimulatedDiscoveryProvider(), adapter });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.artifact.steps[0].target.locators, adapter.expectedLocators.fieldLocators);
  assert.deepEqual(result.artifact.steps[1].target.locators, adapter.expectedLocators.buttonLocators);
  assert.deepEqual(result.artifact.steps[3].target.locators, adapter.expectedLocators.balanceLocators);
  assert.equal(JSON.stringify(result.artifact).includes("member_number"), false);
});

test("unsupported or mutating goals fail before the target is prepared", async () => {
  for (const goal of [
    "Permanently close the member savings account and report its balance and status.",
    "Terminate the member savings account and report its balance and status.",
    "Deactivate the member savings account and report its balance and status.",
    "Cancel the member savings account and report its balance and status.",
    "Look up member {{memberId}} and return the savings balance and account status, then terminate it.",
  ]) {
    const adapter = discoveryAdapter();
    const result = await runDiscovery({ ...fixed, goal, provider: createSimulatedDiscoveryProvider(), adapter });
    assert.equal(result.status, "failure");
    assert.equal(result.error.code, "unsupported_goal");
    assert.equal(adapter.preparations(), 0);
  }
});

test("supported-goal validation rejects unrelated requests and accepts the exact capability", () => {
  assert.throws(() => validateSupportedDiscoveryGoal("Look up the member mailing address."), /supports only a read-only member savings balance/);
  for (const goal of [fixed.goal, "Retrieve the current savings account balance and account status for member {{memberId}}.", "Show member 12345's savings balance and status."]) assert.doesNotThrow(() => validateSupportedDiscoveryGoal(goal));
});

test("discovery reports not-found as a business outcome without compiling", async () => {
  const result = await runDiscovery({ ...fixed, inputs: { memberId: "00000" }, provider: createSimulatedDiscoveryProvider(), adapter: discoveryAdapter({ notFound: true }) });
  assert.equal(result.status, "business_outcome");
  assert.equal(result.code, "member_not_found");
});

test("discovery hands a live-surface interruption off and resumes the same run", async () => {
  const adapter = discoveryAdapter({ humanRequired: true });
  const paused = await runDiscovery({ ...fixed, inputs: { memberId: "31415" }, provider: createSimulatedDiscoveryProvider(), adapter });
  assert.equal(paused.status, "human_required");
  assert.equal(paused.intervention.code, "operator_acknowledgment_required");
  assert.equal(paused.resume.step, 4);
  assert.equal(adapter.preparations(), 1);

  adapter.acknowledge();
  const resumed = await runDiscovery({
    ...fixed,
    inputs: { memberId: "31415" },
    provider: createSimulatedDiscoveryProvider(),
    adapter,
    resume: paused.resume,
    humanActions: [{ at: fixed.now(), kind: "click", control: "Continue lookup" }],
  });
  assert.equal(resumed.status, "success");
  assert.equal(resumed.runId, paused.runId);
  assert.equal(adapter.preparations(), 1);
  assert.ok(resumed.evidence.some((event) => event.phase === "resume"));
  assert.ok(resumed.evidence.some((event) => event.phase === "handoff" && event.detail.includes("Human click")));
  assert.equal(JSON.stringify(resumed).includes("31415"), false);
});

test("model decisions cannot invent controls or locators", () => {
  const control = { ref: "opaque-4", role: "button", name: "Search Accounts", context: "Inquiry form", visible: true, enabled: true, locatorCandidates: [locator("button_text", "Search Accounts"), locator("css", ".inquiry button")] };
  const context = contextWith([control]);
  assert.throws(() => validateDiscoveryDecision(rawDecision({ action: "click", controlRef: "not-observed", locators: control.locatorCandidates, reason: "Submit the form." }), context), /not visible/);
  assert.throws(() => validateDiscoveryDecision(rawDecision({ action: "click", controlRef: control.ref, locators: [control.locatorCandidates[0], locator("css", "#delete-member")], reason: "Submit the form." }), context), /not derived from the observed control/);
});

test("model decisions cannot use the wrong role or disabled observed controls", () => {
  const disabled = { ref: "opaque-7", role: "button", name: "Search", context: "Inquiry", visible: true, enabled: false, locatorCandidates: [locator("button_text", "Search"), locator("css", "button.search")] };
  assert.throws(() => validateDiscoveryDecision(rawDecision({ action: "click", controlRef: disabled.ref, locators: disabled.locatorCandidates, reason: "Submit lookup." }), contextWith([disabled])), /visible but disabled/);
  const text = { ...disabled, ref: "opaque-8", role: "text", enabled: true };
  assert.throws(() => validateDiscoveryDecision(rawDecision({ action: "click", controlRef: text.ref, locators: text.locatorCandidates, reason: "Click text." }), contextWith([text])), /not allowed for click/);
});

test("capability compiler rejects an incomplete successful trace", () => {
  const target = { description: "Observed member input", locators: [locator("name", "member"), locator("css", "input.member")] };
  assert.throws(() => compileDiscoveredCapability({ goal: fixed.goal, provider: "test", trace: [{ action: "type", target, controlRef: "opaque", input: "memberId", output: null }], checkpointTarget: target, capabilityName: "get_savings_balance", generatedAt: fixed.now() }), /missing required reusable actions/);
});

test("OpenAI provider uses structured outputs, observed candidates, and no storage", async () => {
  let requestBody;
  const control = { ref: "opaque-input", role: "textbox", name: "Member Number", context: "Inquiry form", visible: true, enabled: true, locatorCandidates: [locator("name", "member_number"), locator("css", "form input")] };
  const context = contextWith([control]);
  context.goal = redactDiscoveryText("Look up member 12345 and return their savings balance and account status.");
  const responseDecision = rawDecision({ action: "type", controlRef: control.ref, locators: control.locatorCandidates, input: "memberId", reason: "Enter the declared member input." });
  const decision = await decideWithOpenAI({
    apiKey: "test-key",
    model: "test-model",
    context,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ output_text: JSON.stringify(responseDecision) }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(decision.action, "type");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(JSON.stringify(requestBody.text.format.schema).includes("targetId"), false);
  assert.equal(JSON.stringify(requestBody.text.format.schema).includes("controlRef"), true);
  assert.equal(requestBody.input.includes("12345"), false);
});

test("adaptive provider falls back only for an explicitly unavailable live provider", async () => {
  const control = { ref: "opaque-input", role: "textbox", name: "Member Number", context: "Inquiry", visible: true, enabled: true, locatorCandidates: [locator("name", "member_number"), locator("css", "form input")] };
  const context = contextWith([control]);
  const provider = createAdaptiveDiscoveryProvider(async () => new Response(JSON.stringify({ error: "provider_unavailable", fallback: "safe-simulator" }), { status: 503 }));
  const result = await provider.decide(context);
  assert.equal(result.provider, "safe-simulator");
  assert.equal(result.decision.action, "type");

  const unreachable = createAdaptiveDiscoveryProvider(async () => { throw new Error("network down"); });
  await assert.rejects(() => unreachable.decide(context), /could not be reached/);
  const badGateway = createAdaptiveDiscoveryProvider(async () => new Response(JSON.stringify({ error: "bad_gateway" }), { status: 502 }));
  await assert.rejects(() => badGateway.decide(context), /could not produce a decision/);
});
