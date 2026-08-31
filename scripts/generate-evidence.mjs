import { readFile, writeFile } from "node:fs/promises";
import { AutomationError, HumanInterventionError, executeCapability } from "../lib/automation/core.ts";
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
    { ref: "surface-1", role: "textbox", name: "Member Number", context: "Account inquiry form", visible: true, enabled: true, filled, locatorCandidates: [{ kind: "name", value: "member_number" }, { kind: "css", value: "form input" }] },
    { ref: "surface-2", role: "button", name: "Retrieve Record", context: "Account inquiry form", visible: true, enabled: true, locatorCandidates: [{ kind: "button_text", value: "Retrieve Record" }, { kind: "css", value: "form button[type='submit']" }] },
    { ref: "surface-3", role: "combobox", name: "Inquiry Type", context: "Account inquiry form", visible: true, enabled: true, locatorCandidates: [{ kind: "name", value: "inquiry_type" }, { kind: "css", value: "form select" }] },
    { ref: "surface-4", role: "button", name: "Clear", context: "Reset the form", visible: true, enabled: true, locatorCandidates: [{ kind: "button_text", value: "Clear" }, { kind: "css", value: "form button[type='button']" }] },
  ];
  return {
    async prepare() { state = "form"; filled = false; },
    currentUrl: () => `${origin}/legacy`,
    async observe() {
      const controls = state === "summary"
        ? [
            ...formControls(),
            { ref: "surface-5", role: "region", name: "Member account summary", context: "Lookup result", visible: true, locatorCandidates: [{ kind: "css", value: ".member-result" }, { kind: "css", value: ".legacy-window.member-result" }] },
            { ref: "surface-6", role: "text", name: "Current Balance cell", context: "Account row: REGULAR SAVINGS", visible: true, hasValue: true, outputBinding: "balance", locatorCandidates: [{ kind: "css", value: ".savings-balance" }, { kind: "css", value: ".accounts-grid td:nth-of-type(3)" }] },
            { ref: "surface-7", role: "text", name: "Status cell", context: "Account row: REGULAR SAVINGS", visible: true, hasValue: true, outputBinding: "accountStatus", locatorCandidates: [{ kind: "css", value: ".account-status" }, { kind: "css", value: ".accounts-grid td:nth-of-type(4)" }] },
          ]
        : formControls();
      return { url: `${origin}/legacy`, title: "Northstar Core Member Services", controls };
    },
    async execute(decision, inputs) {
      if (decision.action === "type") { filled = Boolean(inputs.memberId); return { locator: "name:member_number" }; }
      if (decision.action === "click") { state = "loading"; return { locator: "button_text:Retrieve Record" }; }
      if (decision.action === "wait_for_change") { state = "summary"; return {}; }
      if (decision.output === "balance") return { value: "$2,458.17", locator: "css:.savings-balance" };
      return { value: "Active", locator: "css:.account-status" };
    },
    sessionIdentity: () => `${origin}/legacy?evidence=discovery`,
    async snapshot() { return { surface: "web", path: "/legacy", title: "Northstar Core Member Services", visibleSignals: [state], sanitizedDom: `Northstar evidence fixture ${state}` }; },
    async verify(target) { return state === "summary" && target.locators.some((item) => item.value === ".member-result"); },
  };
}

function replayAdapter({ notFound = false, intervention = false, applicationError = false } = {}) {
  let blocked = intervention;
  let memberId = "";
  const adapter = {
    async prepare() {},
    currentUrl: () => `${origin}/legacy`,
    sessionIdentity: () => `${origin}/legacy?evidence=replay`,
    async snapshot() {
      return {
        surface: "web",
        path: "/legacy",
        title: "Northstar Core Member Services",
        visibleSignals: [applicationError ? "application_unavailable" : blocked ? "permission_dialog" : notFound ? "member_not_found" : "member_summary"],
        sanitizedDom: applicationError ? "SYSTEM 500: CORE MEMBER SERVICES IS UNAVAILABLE." : "Sanitized Northstar runtime fixture.",
      };
    },
    type: async (_target, value) => { memberId = value; return "name:member_number"; },
    click: async () => "button_text:Retrieve Record",
    async waitForOutcome(outcomes) {
      if (applicationError) throw new AutomationError("application_unavailable", "hard_failure", "CORE MEMBER SERVICES IS UNAVAILABLE");
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
      const restricted = memberId === "31415";
      return /balance/i.test(target.description)
        ? { value: restricted ? "$12,104.62" : "$2,458.17", locator: "css:.accounts-grid tbody tr .savings-balance" }
        : { value: restricted ? "Restricted" : "Active", locator: "css:.accounts-grid tbody tr .account-status" };
    },
    verify: async () => true,
  };
  return { adapter, acknowledge: () => { blocked = false; } };
}

function envelope(scenario, result, usedArtifact = artifact) {
  return {
    schemaVersion: "1.0",
    scenario,
    artifact: `${usedArtifact.name}@${usedArtifact.version}`,
    generatedBy: "scripts/generate-evidence.mjs",
    sensitiveValuesStored: false,
    modelTranscriptStored: false,
    result,
  };
}

const discovery = await runDiscovery({
  goal: "Look up member {{memberId}} and return the current savings balance and account status.",
  target: "/legacy",
  inputs: { memberId: "12345" },
  origin,
  provider: createSimulatedDiscoveryProvider(),
  adapter: discoveryAdapter(),
  runId: "evidence-discovery-success",
  now: clock("2026-08-29T14:00:00.000Z"),
});
if (discovery.status !== "success") throw new Error("Discovery evidence did not compile a capability.");
const generatedArtifact = discovery.artifact;

const replay = replayAdapter();
const replayResult = await executeCapability({
  artifact: generatedArtifact,
  inputs: { memberId: "12345" },
  origin,
  adapter: replay.adapter,
  runId: "evidence-replay-success",
  now: clock("2026-08-29T14:10:00.000Z"),
});

const notFound = replayAdapter({ notFound: true });
const notFoundResult = await executeCapability({
  artifact: generatedArtifact,
  inputs: { memberId: "00000" },
  origin,
  adapter: notFound.adapter,
  runId: "evidence-replay-not-found",
  now: clock("2026-08-29T14:20:00.000Z"),
});

const handoff = replayAdapter({ intervention: true });
const paused = await executeCapability({
  artifact: generatedArtifact,
  inputs: { memberId: "31415" },
  origin,
  adapter: handoff.adapter,
  runId: "evidence-handoff-success",
  now: clock("2026-08-29T14:30:00.000Z"),
});
if (paused.status !== "human_required") throw new Error("Handoff evidence did not reach human_required.");
handoff.acknowledge();
const handoffResult = await executeCapability({
  artifact: generatedArtifact,
  inputs: { memberId: "31415" },
  origin,
  adapter: handoff.adapter,
  resume: paused.resume,
  humanActions: [{ at: "2026-08-29T14:30:05.000Z", kind: "click", control: "Continue lookup" }],
  now: clock("2026-08-29T14:31:00.000Z"),
});

const failed = replayAdapter({ applicationError: true });
const failureResult = await executeCapability({
  artifact: generatedArtifact,
  inputs: { memberId: "12345" },
  origin,
  adapter: failed.adapter,
  runId: "evidence-replay-failure",
  now: clock("2026-08-29T14:40:00.000Z"),
});

const files = [
  ["discovery-success.json", envelope("simulated-provider live-contract discovery fixture", discovery, generatedArtifact)],
  ["replay-success.json", envelope("discovered artifact deterministic replay", replayResult, generatedArtifact)],
  ["replay-not-found.json", envelope("discovered artifact known business outcome", notFoundResult, generatedArtifact)],
  ["handoff-success.json", envelope("restricted-account same-session human handoff", handoffResult, generatedArtifact)],
  ["replay-failure.json", envelope("discovered artifact hard application failure with sanitized DOM snapshot", failureResult, generatedArtifact)],
];

for (const [name, contents] of files) {
  await writeFile(new URL(`../evidence/${name}`, import.meta.url), `${JSON.stringify(contents, null, 2)}\n`);
}

console.log(`Generated ${files.length} runtime evidence files for ${generatedArtifact.name}@${generatedArtifact.version}.`);
