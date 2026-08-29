import { readFile, writeFile } from "node:fs/promises";
import { HumanInterventionError, executeCapability } from "../lib/automation/core.ts";
import { createSimulatedDiscoveryProvider, runDiscovery } from "../lib/discovery/core.ts";

const artifact = JSON.parse(await readFile(new URL("../capabilities/get-savings-balance.v1.json", import.meta.url), "utf8"));
const origin = "http://localhost:3000";

function clock(start) {
  let tick = 0;
  const epoch = Date.parse(start);
  return () => new Date(epoch + tick++ * 1000).toISOString();
}

function discoveryAdapter() {
  let state = "form";
  let filled = false;
  const formControls = () => [
    { id: "member_number", role: "textbox", name: "Member Number input", visible: true, enabled: true, filled },
    { id: "retrieve_record", role: "button", name: "Retrieve Record button", visible: true, enabled: true },
  ];
  return {
    async prepare() { state = "form"; filled = false; },
    currentUrl: () => `${origin}/legacy`,
    async observe() {
      const controls = state === "summary"
        ? [
            ...formControls(),
            { id: "member_summary", role: "region", name: "Member summary panel", visible: true },
            { id: "savings_balance", role: "text", name: "Savings balance", visible: true, hasValue: true },
            { id: "account_status", role: "text", name: "Account status", visible: true, hasValue: true },
          ]
        : formControls();
      return { url: `${origin}/legacy`, title: "Northstar Core Member Services", controls };
    },
    async execute(decision, inputs) {
      if (decision.action === "type") { filled = Boolean(inputs.memberId); return { locator: "name:member_number" }; }
      if (decision.action === "click") { state = "loading"; return { locator: "button_text:Retrieve Record" }; }
      if (decision.action === "wait_for_outcome") { state = "summary"; return { outcome: "success" }; }
      if (decision.targetId === "savings_balance") return { value: "$2,458.17", locator: "css:.accounts-grid tbody tr .savings-balance" };
      return { value: "Active", locator: "css:.accounts-grid tbody tr .account-status" };
    },
    async verify(targetId) { return targetId === "member_summary" && state === "summary"; },
  };
}

function replayAdapter({ notFound = false, intervention = false } = {}) {
  let blocked = intervention;
  const adapter = {
    async prepare() {},
    currentUrl: () => `${origin}/legacy`,
    type: async () => "name:member_number",
    click: async () => "button_text:Retrieve Record",
    async waitForOutcome(outcomes) {
      if (blocked) {
        throw new HumanInterventionError(
          "operator_acknowledgment_required",
          "Automation paused at a restricted-account acknowledgment and routed the live session to an operator.",
          { surface: "web", path: "/legacy", title: "Northstar Core Member Services", visibleSignals: ["permission_dialog", "continue_lookup", "session_active"] },
        );
      }
      return outcomes.find((outcome) => outcome.kind === (notFound ? "business_outcome" : "success"));
    },
    async extract(target) {
      return target.description.includes("balance")
        ? { value: "$2,458.17", locator: "css:.accounts-grid tbody tr .savings-balance" }
        : { value: "Active", locator: "css:.accounts-grid tbody tr .account-status" };
    },
    verify: async () => true,
  };
  return { adapter, acknowledge: () => { blocked = false; } };
}

function envelope(scenario, result) {
  return {
    schemaVersion: "1.0",
    scenario,
    artifact: `${artifact.name}@${artifact.version}`,
    generatedBy: "scripts/generate-evidence.mjs",
    sensitiveValuesStored: false,
    modelTranscriptStored: false,
    result,
  };
}

const discovery = await runDiscovery({
  goal: "Look up member {{memberId}} and return the current savings balance and account status.",
  inputs: { memberId: "12345" },
  origin,
  provider: createSimulatedDiscoveryProvider(),
  adapter: discoveryAdapter(),
  runId: "evidence-discovery-success",
  now: clock("2026-08-29T14:00:00.000Z"),
});

const replay = replayAdapter();
const replayResult = await executeCapability({
  artifact,
  inputs: { memberId: "12345" },
  origin,
  adapter: replay.adapter,
  runId: "evidence-replay-success",
  now: clock("2026-08-29T14:10:00.000Z"),
});

const notFound = replayAdapter({ notFound: true });
const notFoundResult = await executeCapability({
  artifact,
  inputs: { memberId: "00000" },
  origin,
  adapter: notFound.adapter,
  runId: "evidence-replay-not-found",
  now: clock("2026-08-29T14:20:00.000Z"),
});

const handoff = replayAdapter({ intervention: true });
const paused = await executeCapability({
  artifact,
  inputs: { memberId: "31415" },
  origin,
  adapter: handoff.adapter,
  runId: "evidence-handoff-success",
  now: clock("2026-08-29T14:30:00.000Z"),
});
if (paused.status !== "human_required") throw new Error("Handoff evidence did not reach human_required.");
handoff.acknowledge();
const handoffResult = await executeCapability({
  artifact,
  inputs: { memberId: "31415" },
  origin,
  adapter: handoff.adapter,
  resume: paused.resume,
  humanActions: [{ at: "2026-08-29T14:30:05.000Z", kind: "click", control: "Continue lookup" }],
  now: clock("2026-08-29T14:31:00.000Z"),
});

const files = [
  ["discovery-success.json", envelope("goal-driven savings lookup discovery", discovery)],
  ["replay-success.json", envelope("generated artifact deterministic replay", replayResult)],
  ["replay-not-found.json", envelope("generated artifact known business outcome", notFoundResult)],
  ["handoff-success.json", envelope("restricted-account same-session human handoff", handoffResult)],
];

for (const [name, contents] of files) {
  await writeFile(new URL(`../evidence/${name}`, import.meta.url), `${JSON.stringify(contents, null, 2)}\n`);
}

console.log(`Generated ${files.length} runtime evidence files for ${artifact.name}@${artifact.version}.`);
