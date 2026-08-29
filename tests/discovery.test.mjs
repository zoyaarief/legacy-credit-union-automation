import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_CATALOG,
  compileDiscoveredCapability,
  createSimulatedDiscoveryProvider,
  redactDiscoveryText,
  runDiscovery,
  validateSupportedDiscoveryGoal,
  validateDiscoveryDecision,
} from "../lib/discovery/core.ts";
import { decideWithOpenAI } from "../lib/discovery/openai.ts";
import { createAdaptiveDiscoveryProvider } from "../lib/discovery/provider-client.ts";

function discoveryAdapter({ notFound = false } = {}) {
  let state = "form";
  let filled = false;
  const formControls = () => [
    { id: "member_number", role: "textbox", name: "Member Number input", visible: true, enabled: true, filled },
    { id: "retrieve_record", role: "button", name: "Retrieve Record button", visible: true, enabled: true },
  ];
  return {
    async prepare() { state = "form"; filled = false; },
    currentUrl: () => "http://localhost:3000/legacy",
    async observe() {
      const controls = state === "summary"
        ? [
            ...formControls(),
            { id: "member_summary", role: "region", name: "Member summary panel", visible: true },
            { id: "savings_balance", role: "text", name: "Savings balance", visible: true, hasValue: true },
            { id: "account_status", role: "text", name: "Account status", visible: true, hasValue: true },
          ]
        : state === "notfound"
          ? [...formControls(), { id: "member_not_found", role: "status", name: "Member not found", visible: true }]
          : formControls();
      return { url: "http://localhost:3000/legacy", title: "Northstar Member Services", controls };
    },
    async execute(decision, inputs) {
      if (decision.action === "type") { filled = Boolean(inputs.memberId); return { locator: "name:member_number" }; }
      if (decision.action === "click") { state = "loading"; return { locator: "button_text:Retrieve Record" }; }
      if (decision.action === "wait_for_outcome") {
        state = notFound ? "notfound" : "summary";
        return notFound ? { outcome: "business_outcome", businessCode: "member_not_found" } : { outcome: "success" };
      }
      if (decision.targetId === "savings_balance") return { value: "$2,458.17" };
      return { value: "Active" };
    },
    async verify(targetId) { return targetId === "member_summary" && state === "summary"; },
  };
}

const fixed = {
  goal: "Look up member {{memberId}} and return the savings balance and account status.",
  inputs: { memberId: "12345" },
  origin: "http://localhost:3000",
  runId: "discovery-test",
  now: () => "2026-08-27T12:00:00.000Z",
};

test("goal-driven discovery completes and compiles a replayable artifact", async () => {
  const result = await runDiscovery({
    ...fixed,
    provider: createSimulatedDiscoveryProvider(),
    adapter: discoveryAdapter(),
  });

  assert.equal(result.status, "success");
  assert.equal(result.provider, "safe-simulator");
  assert.deepEqual(result.outputs, { balance: "$2,458.17", accountStatus: "Active" });
  assert.equal(result.artifact.name, "get_savings_balance");
  assert.equal(result.artifact.version, "1.1.0");
  assert.equal(result.artifact.steps.length, 5);
  assert.equal(result.evidence.at(-1).phase, "complete");
  assert.equal(JSON.stringify(result).includes("12345"), false);
});

test("unsupported or mutating goals fail before the target is prepared", async () => {
  let prepared = false;
  const unsafeAdapter = discoveryAdapter();
  unsafeAdapter.prepare = async () => { prepared = true; };
  const result = await runDiscovery({
    ...fixed,
    goal: "Permanently close the member savings account and report its balance and status.",
    provider: createSimulatedDiscoveryProvider(),
    adapter: unsafeAdapter,
  });

  assert.equal(result.status, "failure");
  assert.equal(result.error.code, "unsupported_goal");
  assert.equal(result.error.category, undefined);
  assert.equal(prepared, false);
});

test("supported-goal validation rejects unrelated read-only requests", () => {
  assert.throws(() => validateSupportedDiscoveryGoal("Look up the member mailing address."), /supports only a read-only member savings balance/);
});

test("discovery reports not-found as a business outcome without compiling", async () => {
  const result = await runDiscovery({
    ...fixed,
    inputs: { memberId: "00000" },
    provider: createSimulatedDiscoveryProvider(),
    adapter: discoveryAdapter({ notFound: true }),
  });

  assert.equal(result.status, "business_outcome");
  assert.equal(result.code, "member_not_found");
});

test("model decisions cannot select arbitrary controls", () => {
  const context = {
    goal: fixed.goal,
    step: 1,
    maxSteps: 8,
    inputContract: { memberId: { type: "string", sensitive: true } },
    outputContract: { balance: { type: "currency" }, accountStatus: { type: "string" } },
    observation: {
      url: "http://localhost:3000/legacy",
      title: "Northstar",
      controls: [{ id: "member_number", role: "textbox", name: "Member Number", visible: true }],
    },
    history: [],
  };

  assert.throws(
    () => validateDiscoveryDecision({ action: "click", targetId: "delete_member", input: null, output: null, reason: "Delete it", capabilityName: null }, context),
    /not allowed/,
  );
});

test("model decisions cannot operate a disabled observed control", () => {
  const context = {
    goal: fixed.goal,
    step: 2,
    maxSteps: 8,
    inputContract: { memberId: { type: "string", sensitive: true } },
    outputContract: { balance: { type: "currency" }, accountStatus: { type: "string" } },
    observation: {
      url: "http://localhost:3000/legacy",
      title: "Northstar",
      controls: [{ id: "retrieve_record", role: "button", name: "Retrieve Record", visible: true, enabled: false }],
    },
    history: [],
  };

  assert.throws(
    () => validateDiscoveryDecision({ action: "click", targetId: "retrieve_record", input: null, output: null, reason: "Submit lookup.", capabilityName: null }, context),
    /visible but disabled/,
  );
});

test("capability compiler rejects an incomplete successful trace", () => {
  assert.throws(
    () => compileDiscoveredCapability({
      goal: fixed.goal,
      provider: "test",
      trace: [{ action: "type", targetId: "member_number", input: "memberId", output: null }],
      capabilityName: "get_savings_balance",
      generatedAt: fixed.now(),
    }),
    /missing required reusable actions/,
  );
});

test("OpenAI provider uses structured outputs and does not store the response", async () => {
  let requestBody;
  const context = {
    goal: redactDiscoveryText("Look up member 12345 and return their savings balance."),
    step: 1,
    maxSteps: 8,
    inputContract: { memberId: { type: "string", sensitive: true } },
    outputContract: { balance: { type: "currency" }, accountStatus: { type: "string" } },
    observation: { url: "http://localhost:3000/legacy", title: "Northstar", controls: [{ id: "member_number", role: "textbox", name: "Member Number", visible: true }] },
    history: [],
  };
  const decision = await decideWithOpenAI({
    apiKey: "test-key",
    model: "test-model",
    context,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ action: "type", targetId: "member_number", input: "memberId", output: null, reason: "Enter the declared member input.", capabilityName: null }),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(decision.action, "type");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.input.includes("12345"), false);
});

test("adaptive provider falls back explicitly when the live provider is unavailable", async () => {
  const provider = createAdaptiveDiscoveryProvider(async () => new Response(JSON.stringify({ error: "provider_unavailable" }), { status: 503 }));
  const context = {
    goal: fixed.goal,
    step: 1,
    maxSteps: 8,
    inputContract: { memberId: { type: "string", sensitive: true } },
    outputContract: { balance: { type: "currency" }, accountStatus: { type: "string" } },
    observation: { url: "http://localhost:3000/legacy", title: "Northstar", controls: [{ id: "member_number", role: "textbox", name: "Member Number", visible: true }] },
    history: [],
  };
  const result = await provider.decide(context);
  assert.equal(result.provider, "safe-simulator");
  assert.equal(result.decision.action, "type");
});

test("target catalog always carries ordered locator fallbacks", () => {
  assert.ok(Object.values(TARGET_CATALOG).every((target) => target.locators.length >= 2));
});
