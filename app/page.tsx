"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import {
  AutomationError,
  HumanInterventionError,
  executeCapability,
  executeCapabilityWithRecovery,
  validateCapability,
  type Capability,
  type ControlTarget,
  type EvidenceEvent,
  type HumanAction,
  type OutcomeDefinition,
  type ReplayResult,
  type ReplayResume,
  type SurfaceAdapter,
} from "@/lib/automation/core";
import {
  DISCOVERY_OUTCOMES,
  TARGET_CATALOG,
  runDiscovery,
  type DiscoveryAdapter,
  type DiscoveryDecision,
  type DiscoveryEvidenceEvent,
  type DiscoveryResult,
  type ObservedControl,
  type TargetId,
} from "@/lib/discovery/core";
import { createAdaptiveDiscoveryProvider } from "@/lib/discovery/provider-client";
import { INITIAL_HANDOFF_STATE, transitionHandoff, type HandoffState } from "@/lib/handoff/core";
import type { CapabilityCatalogEntry, InvocationTicket } from "@/lib/automation/catalog";
import { scoreStability, type StabilityRun, type StabilityScore } from "@/lib/automation/stability";
import { capabilityFingerprint, type ArtifactReview, type RunRecord, type RunRecordInput } from "@/lib/persistence/contracts";

const savedCapability = validateCapability(rawCapability);
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

type Mode = "discover" | "replay" | "handoff" | "catalog";
type RunStatus = "idle" | "running" | ReplayResult["status"];
type DiscoveryStatus = "idle" | "running" | DiscoveryResult["status"];
type LogEntry = { time: string; step: string; detail: string; state: "ok" | "warn" | "error"; provider?: string };
type StoredRun = RunRecord;
type FaultMode = "none" | "session_expired" | "slow_load" | "application_error";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function getDocument(frame: HTMLIFrameElement) {
  const document = frame.contentDocument;
  if (!document) throw new AutomationError("target_unavailable", "recoverable", "The target application is not available.", true);
  return document;
}

function findTarget(document: Document, target: ControlTarget) {
  for (const candidate of target.locators) {
    let element: Element | null = null;
    if (candidate.kind === "name") element = document.querySelector(`[name="${CSS.escape(candidate.value)}"]`);
    if (candidate.kind === "css") element = document.querySelector(candidate.value);
    if (candidate.kind === "button_text") {
      element = [...document.querySelectorAll("button, input[type='submit']")].find(
        (item) => (item.textContent?.trim() || item.getAttribute("value")) === candidate.value,
      ) ?? null;
    }
    if (element) return { element, locator: `${candidate.kind}:${candidate.value}` };
  }
  return null;
}

function requireTarget(document: Document, target: ControlTarget) {
  const found = findTarget(document, target);
  if (!found) throw new AutomationError("locator_not_found", "hard_failure", `No locator matched ${target.description}.`);
  return found;
}

async function reloadFrame(frame: HTMLIFrameElement, entryPoint: string, run: number, faultMode: FaultMode = "none") {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new AutomationError("target_timeout", "recoverable", "Target load timed out.", true)), 5000);
    frame.onload = () => {
      const readinessDeadline = Date.now() + 2000;
      const checkReady = () => {
        try {
          if (frame.contentDocument?.documentElement.dataset.automationReady === "true") {
            window.clearTimeout(timer); resolve(); return;
          }
        } catch {
          window.clearTimeout(timer); reject(new AutomationError("policy_denied", "policy_denied", "The target surface became cross-origin.")); return;
        }
        if (Date.now() >= readinessDeadline) {
          window.clearTimeout(timer); reject(new AutomationError("target_not_ready", "recoverable", "Target loaded but did not become interactive.", true)); return;
        }
        window.setTimeout(checkReady, 25);
      };
      checkReady();
    };
    const target = new URL(entryPoint, window.location.origin);
    target.searchParams.set("embedded", "1");
    target.searchParams.set("run", String(run));
    if (faultMode !== "none") target.searchParams.set("fault", faultMode);
    frame.src = `${target.pathname}${target.search}`;
  });
}

function currentFrameUrl(frame: HTMLIFrameElement) {
  try { return frame.contentWindow?.location.href ?? ""; }
  catch { throw new AutomationError("policy_denied", "policy_denied", "The live surface became cross-origin."); }
}

async function typeIntoTarget(frame: HTMLIFrameElement, target: ControlTarget, value: string) {
  const found = requireTarget(getDocument(frame), target);
  const input = found.element as HTMLInputElement;
  const targetWindow = frame.contentWindow;
  if (!targetWindow) throw new AutomationError("target_unavailable", "recoverable", "The target window is unavailable.", true);
  const constructors = targetWindow as unknown as { HTMLInputElement: typeof HTMLInputElement; Event: typeof Event };
  const nativeValueSetter = Object.getOwnPropertyDescriptor(constructors.HTMLInputElement.prototype, "value")?.set;
  if (!nativeValueSetter) throw new AutomationError("control_not_editable", "hard_failure", `${target.description} cannot accept values.`);
  input.focus(); nativeValueSetter.call(input, value);
  input.dispatchEvent(new constructors.Event("input", { bubbles: true }));
  input.dispatchEvent(new constructors.Event("change", { bubbles: true }));
  await pause(50);
  return found.locator;
}

async function clickTarget(frame: HTMLIFrameElement, target: ControlTarget) {
  const found = requireTarget(getDocument(frame), target);
  (found.element as HTMLElement).click();
  return found.locator;
}

async function waitForOutcomes(frame: HTMLIFrameElement, outcomes: OutcomeDefinition[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const document = getDocument(frame);
    if (document.querySelector("#session-expired")) throw new AutomationError("session_expired", "recoverable", "The operator session expired before the result was available.", true);
    if (document.querySelector("#application-error")) throw new AutomationError("application_unavailable", "hard_failure", "Core Member Services returned an application error.");
    if (document.querySelector("#permission-dialog")) {
      throw new HumanInterventionError(
        "operator_acknowledgment_required",
        "Automation paused at a restricted-account acknowledgment and routed the live session to an operator.",
        { surface: "web", path: new URL(currentFrameUrl(frame)).pathname, title: document.title || "Northstar Core Member Services", visibleSignals: ["permission_dialog", "continue_lookup", "session_active"] },
      );
    }
    for (const outcome of outcomes) if (findTarget(document, outcome.target)) return outcome;
    await pause(100);
  }
  throw new AutomationError("outcome_timeout", "recoverable", "No declared outcome appeared before the step timeout.", true);
}

function createReplayAdapter(frame: HTMLIFrameElement, nextRun: () => number, faultMode: FaultMode = "none"): SurfaceAdapter {
  return {
    prepare: (entryPoint) => reloadFrame(frame, entryPoint, nextRun(), faultMode),
    currentUrl: () => currentFrameUrl(frame),
    type: (target, value) => typeIntoTarget(frame, target, value),
    click: (target) => clickTarget(frame, target),
    waitForOutcome: (outcomes, timeoutMs) => waitForOutcomes(frame, outcomes, timeoutMs),
    async extract(target) { return requireTarget(getDocument(frame), target).element.textContent?.trim() ?? ""; },
    async verify(target) { return Boolean(findTarget(getDocument(frame), target)); },
  };
}

function observedControl(document: Document, id: TargetId, role: ObservedControl["role"], options: Partial<ObservedControl> = {}) {
  const found = findTarget(document, TARGET_CATALOG[id]);
  if (!found) return null;
  return { id, role, name: TARGET_CATALOG[id].description, visible: true, ...options } satisfies ObservedControl;
}

function createDiscoveryAdapter(frame: HTMLIFrameElement, nextRun: () => number): DiscoveryAdapter {
  return {
    prepare: (entryPoint) => reloadFrame(frame, entryPoint, nextRun()),
    currentUrl: () => currentFrameUrl(frame),
    async observe() {
      const document = getDocument(frame);
      const memberInput = findTarget(document, TARGET_CATALOG.member_number)?.element as HTMLInputElement | undefined;
      const retrieveButton = findTarget(document, TARGET_CATALOG.retrieve_record)?.element as HTMLButtonElement | undefined;
      const controls = [
        observedControl(document, "member_number", "textbox", { enabled: !memberInput?.disabled, filled: Boolean(memberInput?.value) }),
        observedControl(document, "retrieve_record", "button", { enabled: !retrieveButton?.disabled }),
        observedControl(document, "member_summary", "region"), observedControl(document, "member_not_found", "status"),
        observedControl(document, "savings_balance", "text", { hasValue: true }), observedControl(document, "account_status", "text", { hasValue: true }),
      ].filter((control): control is ObservedControl => Boolean(control));
      return { url: currentFrameUrl(frame), title: "Northstar Core Member Services", controls };
    },
    async execute(decision: DiscoveryDecision, inputs: Record<string, string>) {
      if (!decision.targetId) throw new AutomationError("model_contract_invalid", "hard_failure", "Decision target is missing.");
      if (decision.action === "type") {
        if (!decision.input) throw new AutomationError("model_contract_invalid", "hard_failure", "Decision input is missing.");
        return { locator: await typeIntoTarget(frame, TARGET_CATALOG[decision.targetId], inputs[decision.input]) };
      }
      if (decision.action === "click") return { locator: await clickTarget(frame, TARGET_CATALOG[decision.targetId]) };
      if (decision.action === "wait_for_outcome") {
        const outcome = await waitForOutcomes(frame, DISCOVERY_OUTCOMES, 5000);
        return outcome.kind === "business_outcome" ? { outcome: "business_outcome", businessCode: outcome.code } : { outcome: "success" };
      }
      if (decision.action === "extract") {
        const value = requireTarget(getDocument(frame), TARGET_CATALOG[decision.targetId]).element.textContent?.trim() ?? "";
        if (!value) throw new AutomationError("output_missing", "hard_failure", `${decision.output} was empty.`);
        return { value };
      }
      throw new AutomationError("model_contract_invalid", "hard_failure", "Complete actions are verified by the discovery engine.");
    },
    async verify(targetId) { return Boolean(findTarget(getDocument(frame), TARGET_CATALOG[targetId])); },
  };
}

function captureHumanActions(frame: HTMLIFrameElement, onAction: (action: HumanAction) => void) {
  const document = getDocument(frame);
  const describe = (element: Element) => (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || element.tagName).trim().slice(0, 120);
  const click = (event: Event) => {
    const control = (event.target as Element | null)?.closest("button, a, input, select, textarea");
    if (control) onAction({ at: new Date().toISOString(), kind: "click", control: describe(control) });
  };
  const input = (event: Event) => {
    const control = event.target as Element | null;
    if (control) onAction({ at: new Date().toISOString(), kind: "input", control: control.getAttribute("name") || control.tagName });
  };
  document.addEventListener("click", click, true); document.addEventListener("change", input, true);
  return () => { document.removeEventListener("click", click, true); document.removeEventListener("change", input, true); };
}

function toReplayLog(event: EvidenceEvent): LogEntry {
  return { time: formatTime(event.at), step: event.stepId, detail: event.detail, state: event.outcome === "error" ? "error" : ["business_outcome", "intervention"].includes(event.outcome) ? "warn" : "ok" };
}
function toDiscoveryLog(event: DiscoveryEvidenceEvent): LogEntry {
  return { time: formatTime(event.at), step: `${String(event.step).padStart(2, "0")} · ${event.phase}`, detail: event.detail, state: event.outcome === "error" ? "error" : event.outcome === "business_outcome" ? "warn" : "ok", provider: event.provider };
}
function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const runCounterRef = useRef(0);
  const resumeRef = useRef<ReplayResume | null>(null);
  const stopHumanCaptureRef = useRef<(() => void) | null>(null);
  const [mode, setMode] = useState<Mode>("discover");
  const [goal, setGoal] = useState("Look up member {{memberId}} and return the current savings balance and account status.");
  const [memberId, setMemberId] = useState("12345");
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>("idle");
  const [discoveryLogs, setDiscoveryLogs] = useState<LogEntry[]>([]);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [generatedArtifact, setGeneratedArtifact] = useState<Capability | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [replayLogs, setReplayLogs] = useState<LogEntry[]>([]);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [handoff, setHandoff] = useState<HandoffState>(INITIAL_HANDOFF_STATE);
  const [history, setHistory] = useState<StoredRun[]>([]);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [retentionDays, setRetentionDays] = useState<7 | 30 | 90>(30);
  const [faultMode, setFaultMode] = useState<FaultMode>("none");
  const [artifactReview, setArtifactReview] = useState<ArtifactReview | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<{ attempts: number; recovered: boolean } | null>(null);
  const [catalog, setCatalog] = useState<CapabilityCatalogEntry[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [selectedVariant, setSelectedVariant] = useState("northstar-main");
  const [agentStatus, setAgentStatus] = useState<RunStatus>("idle");
  const [agentLogs, setAgentLogs] = useState<LogEntry[]>([]);
  const [agentResult, setAgentResult] = useState<ReplayResult | null>(null);
  const [activeTicket, setActiveTicket] = useState<InvocationTicket | null>(null);
  const [stability, setStability] = useState<StabilityScore | null>(null);
  const activeArtifact = useMemo(() => generatedArtifact ?? savedCapability, [generatedArtifact]);
  const artifactApproved = !generatedArtifact || artifactReview?.state === "approved";
  const busy = discoveryStatus === "running" || runStatus === "running" || agentStatus === "running" || handoff.owner === "resuming";

  async function loadHistory() {
    try {
      const response = await fetch("/api/runs", { cache: "no-store" });
      if (!response.ok) throw new Error("history unavailable");
      const body = await response.json() as { runs: StoredRun[] };
      setHistory(body.runs); setStorageState("ready");
    } catch { setStorageState("unavailable"); }
  }

  async function loadCatalog() {
    try {
      const response = await fetch("/api/capabilities", { cache: "no-store" });
      if (!response.ok) throw new Error("catalog unavailable");
      const body = await response.json() as { entries: CapabilityCatalogEntry[] };
      setCatalog(body.entries); setCatalogState("ready");
    } catch { setCatalogState("unavailable"); }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadHistory(); void loadCatalog(); }, 0);
    return () => { window.clearTimeout(timer); stopHumanCaptureRef.current?.(); };
  }, []);

  async function persistRun(record: RunRecordInput) {
    try {
      const response = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...record, retentionDays }) });
      if (!response.ok) throw new Error("storage failed");
      await loadHistory();
    } catch { setStorageState("unavailable"); }
  }

  async function registerArtifact(artifact: Capability, approve = false) {
    try {
      const response = await fetch("/api/artifacts", { method: approve ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artifact }) });
      if (!response.ok) throw new Error("review failed");
      const body = await response.json() as { review: ArtifactReview };
      setArtifactReview(body.review);
      return body.review;
    } catch { setStorageState("unavailable"); return null; }
  }

  async function discover(event: FormEvent) {
    event.preventDefault(); const frame = frameRef.current; if (!frame || busy) return;
    setDiscoveryStatus("running"); setDiscoveryLogs([]); setDiscoveryResult(null); setGeneratedArtifact(null);
    const result = await runDiscovery({ goal, inputs: { memberId }, origin: window.location.origin, provider: createAdaptiveDiscoveryProvider(), adapter: createDiscoveryAdapter(frame, () => ++runCounterRef.current), onEvidence: (evidence) => setDiscoveryLogs((items) => [...items, toDiscoveryLog(evidence)]) });
    if (result.status === "success") { setGeneratedArtifact(result.artifact); await registerArtifact(result.artifact); }
    setDiscoveryResult(result); setDiscoveryStatus(result.status);
    await persistRun({ runId: result.runId, kind: "discovery", status: result.status, artifactName: result.status === "success" ? result.artifact.name : "get_savings_balance", artifactVersion: "1.0.0", provider: result.provider, summary: { eventCount: result.evidence.length, outcome: result.status }, evidence: result.evidence, artifact: result.status === "success" ? result.artifact : undefined });
  }

  async function replay(event: FormEvent) {
    event.preventDefault(); const frame = frameRef.current; if (!frame || busy) return;
    setRunStatus("running"); setReplayLogs([]); setReplayResult(null); setRecoveryStatus(null);
    if (!artifactApproved || (generatedArtifact && (await registerArtifact(generatedArtifact))?.state !== "approved")) {
      setRunStatus("idle"); return;
    }
    const execution = await executeCapabilityWithRecovery({
      artifact: activeArtifact,
      inputs: { memberId },
      origin: window.location.origin,
      createAdapter: (attempt) => createReplayAdapter(frame, () => ++runCounterRef.current, attempt === 1 ? faultMode : "none"),
      maxAttempts: 2,
      onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]),
    });
    const result = execution.result;
    setRecoveryStatus({ attempts: execution.attempts, recovered: execution.recovered });
    setReplayResult(result); setRunStatus(result.status);
    if (result.status !== "human_required") await persistRun({ runId: result.runId, kind: "replay", status: result.status, artifactName: activeArtifact.name, artifactVersion: activeArtifact.version, summary: { eventCount: result.evidence.length, outcome: result.status, attempts: execution.attempts, recovered: execution.recovered }, evidence: result.evidence, artifact: activeArtifact });
  }

  async function requestInvocationTicket(): Promise<InvocationTicket> {
    const response = await fetch("/api/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilityName: savedCapability.name, version: savedCapability.version, variantId: selectedVariant, inputs: { memberId } }),
    });
    if (!response.ok) throw new AutomationError("invocation_rejected", "invalid_request", "The catalog rejected this invocation.");
    const body = await response.json() as { ticket: InvocationTicket };
    if (await capabilityFingerprint(body.ticket.artifact) !== body.ticket.artifactHash) {
      throw new AutomationError("ticket_integrity_failed", "policy_denied", "The invocation artifact does not match its catalog fingerprint.");
    }
    return body.ticket;
  }

  async function executeAgentTicket(ticket: InvocationTicket, runLabel: string): Promise<{ result: ReplayResult; stabilityRun: StabilityRun }> {
    const frame = frameRef.current;
    if (!frame) throw new AutomationError("target_unavailable", "recoverable", "The target application is not available.", true);
    const execution = await executeCapabilityWithRecovery({
      artifact: ticket.artifact,
      inputs: ticket.inputs,
      origin: window.location.origin,
      runId: ticket.invocationId,
      createAdapter: () => createReplayAdapter(frame, () => ++runCounterRef.current),
      maxAttempts: 2,
      onEvidence: (evidence) => setAgentLogs((items) => [...items, { ...toReplayLog(evidence), step: `${runLabel} · ${toReplayLog(evidence).step}` }]),
    });
    const result = execution.result;
    await persistRun({
      runId: result.runId,
      kind: "agent_invocation",
      status: result.status,
      artifactName: ticket.capabilityName,
      artifactVersion: ticket.capabilityVersion,
      provider: `catalog:${ticket.variant.id}`,
      summary: { outcome: result.status, attempts: execution.attempts, recovered: execution.recovered, variantId: ticket.variant.id, vendorFamily: ticket.variant.vendorFamily },
      evidence: result.evidence,
      artifact: ticket.artifact,
    });
    return { result, stabilityRun: { status: result.status, attempts: execution.attempts, recovered: execution.recovered } };
  }

  async function invokeFromCatalog() {
    if (busy || memberId.length !== 5) return;
    setAgentStatus("running"); setAgentLogs([]); setAgentResult(null); setStability(null);
    try {
      const ticket = await requestInvocationTicket();
      setActiveTicket(ticket);
      const executed = await executeAgentTicket(ticket, "invoke");
      setAgentResult(executed.result); setAgentStatus(executed.result.status);
    } catch {
      setAgentStatus("failure");
      setAgentResult({ runId: crypto.randomUUID(), status: "failure", error: { category: "invalid_request", code: "invocation_rejected", stepId: "catalog", message: "The catalog invocation could not be issued.", retryable: false }, evidence: [] });
    }
  }

  async function runStabilityCanary() {
    if (busy || memberId.length !== 5) return;
    setAgentStatus("running"); setAgentLogs([]); setAgentResult(null); setStability(null);
    const runs: StabilityRun[] = [];
    try {
      for (let index = 1; index <= 3; index += 1) {
        const ticket = await requestInvocationTicket();
        setActiveTicket(ticket);
        const executed = await executeAgentTicket(ticket, `canary ${index}`);
        runs.push(executed.stabilityRun);
        setAgentResult(executed.result);
      }
      const score = scoreStability(runs);
      setStability(score);
      setAgentStatus(runs.at(-1)?.status ?? "failure");
    } catch {
      const score = scoreStability([...runs, { status: "failure", attempts: 1, recovered: false }]);
      setStability(score); setAgentStatus("failure");
    }
  }

  async function startHandoff() {
    const frame = frameRef.current; if (!frame || busy) return;
    if (!artifactApproved || (generatedArtifact && (await registerArtifact(generatedArtifact))?.state !== "approved")) return;
    stopHumanCaptureRef.current?.(); resumeRef.current = null; setMemberId("31415"); setHandoff(INITIAL_HANDOFF_STATE);
    setRunStatus("running"); setReplayLogs([]); setReplayResult(null);
    const result = await executeCapability({ artifact: activeArtifact, inputs: { memberId: "31415" }, origin: window.location.origin, adapter: createReplayAdapter(frame, () => ++runCounterRef.current), onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]) });
    setReplayResult(result); setRunStatus(result.status);
    if (result.status === "human_required") {
      resumeRef.current = result.resume;
      setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId }));
      await persistRun({ runId: result.runId, kind: "handoff", status: "human_required", artifactName: activeArtifact.name, artifactVersion: activeArtifact.version, summary: { stepId: result.intervention.stepId, reason: result.intervention.code, snapshot: result.intervention.snapshot }, evidence: result.evidence, artifact: activeArtifact });
    }
  }

  function acceptHumanControl() {
    const frame = frameRef.current; if (!frame) return;
    setHandoff((state) => transitionHandoff(state, { type: "accept" }));
    stopHumanCaptureRef.current = captureHumanActions(frame, (action) => setHandoff((state) => transitionHandoff(state, { type: "record", action })));
  }

  async function resumeAutomation() {
    const frame = frameRef.current; const resume = resumeRef.current; if (!frame || !resume || handoff.owner !== "human") return;
    stopHumanCaptureRef.current?.(); stopHumanCaptureRef.current = null;
    setHandoff((state) => transitionHandoff(state, { type: "resume" })); setRunStatus("running");
    const result = await executeCapability({ artifact: activeArtifact, inputs: { memberId: "31415" }, origin: window.location.origin, adapter: createReplayAdapter(frame, () => ++runCounterRef.current), resume, humanActions: handoff.actions, onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]) });
    setReplayLogs(result.evidence.map(toReplayLog)); setReplayResult(result); setRunStatus(result.status);
    if (result.status === "success") setHandoff((state) => transitionHandoff(state, { type: "complete" }));
    await persistRun({ runId: result.runId, kind: "handoff", status: result.status === "human_required" ? "failure" : result.status, artifactName: activeArtifact.name, artifactVersion: activeArtifact.version, summary: { eventCount: result.evidence.length, outcome: result.status, humanActionCount: handoff.actions.length }, evidence: result.evidence, artifact: activeArtifact });
  }

  function useGeneratedArtifact() { setMode("replay"); setRunStatus("idle"); setReplayLogs([]); setReplayResult(null); setRecoveryStatus(null); }
  async function restoreStoredArtifact(run: StoredRun) {
    if (!run.artifact) return;
    try { const artifact = validateCapability(run.artifact); setGeneratedArtifact(artifact); await registerArtifact(artifact); setMode("replay"); setRunStatus("idle"); setReplayResult(null); setReplayLogs([]); setRecoveryStatus(null); } catch { /* server already validates; ignore corrupt history */ }
  }

  async function deleteRun(runId: string) {
    const response = await fetch(`/api/runs?runId=${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (response.ok) await loadHistory();
  }

  const activeLogs = mode === "discover" ? discoveryLogs : mode === "catalog" ? agentLogs : replayLogs;
  const activeStatus = mode === "discover" ? discoveryStatus : mode === "catalog" ? agentStatus : mode === "handoff" && handoff.owner !== "automation" ? handoff.owner : runStatus;
  const catalogEntry = catalog[0];
  const catalogVariant = catalogEntry?.variants.find((variant) => variant.id === selectedVariant);

  return <main className="console-shell">
    <header className="topbar"><div className="brand-lockup"><span className="brand-mark">NC</span><div><p className="eyebrow">Northstar Automation Lab</p><h1>Computer-Use Control Plane</h1></div></div><div className="environment-badge"><span /> Protected demo</div></header>

    <section className="overview-grid phase-two-overview"><div><p className="section-kicker">Phase 6 · Agent capability service</p><h2>Discover once, invoke by contract, measure stability.</h2><p className="lede">Agents now receive a typed capability catalog and invocation ticket. Reviewed tenant variants adapt the target while the same deterministic executor and evidence policy stay in force.</p></div><dl className="capability-facts"><div><dt>Agent contract</dt><dd>Typed catalog API</dd></div><div><dt>Tenant variants</dt><dd>2 reviewed profiles</dd></div><div><dt>Stability window</dt><dd>3 live canaries</dd></div><div><dt>Execution</dt><dd>Deterministic only</dd></div></dl></section>

    <nav className="mode-switch" aria-label="Automation mode">
      <button className={mode === "discover" ? "active" : ""} onClick={() => setMode("discover")} disabled={busy}><span>01</span> Discover</button>
      <button className={mode === "replay" ? "active" : ""} onClick={() => setMode("replay")} disabled={busy}><span>02</span> Replay</button>
      <button className={mode === "handoff" ? "active" : ""} onClick={() => setMode("handoff")} disabled={busy}><span>03</span> Human handoff</button>
      <button className={mode === "catalog" ? "active" : ""} onClick={() => setMode("catalog")} disabled={busy}><span>04</span> Agent API</button>
    </nav>

    <section className="workspace-grid">
      <div className="panel target-panel"><div className="panel-heading"><div><span className="panel-number">LIVE</span><h3>Target session</h3></div><a href="/legacy" target="_blank" rel="noreferrer">Open manually ↗</a></div><div className={`ownership-strip ${handoff.owner}`}><span>Control</span><strong>{mode === "handoff" ? handoff.owner.replace("_", " ") : "automation"}</strong><small>Same session retained</small></div><div className="browser-frame"><div className="browser-bar"><span /><span /><span /><div className="address-bar">allowlisted / legacy / member-services</div></div><iframe ref={frameRef} title="Legacy credit union member portal" src="/legacy?embedded=1" /></div></div>

      <aside className="panel run-panel"><div className="panel-heading"><div><span className="panel-number">{mode === "discover" ? "AI" : mode === "replay" ? "DET" : mode === "handoff" ? "HITL" : "API"}</span><h3>{mode === "discover" ? "Goal-driven discovery" : mode === "replay" ? "Deterministic replay" : mode === "handoff" ? "Intervention control" : "Agent capability catalog"}</h3></div><span className={`status-pill ${activeStatus}`}>{String(activeStatus).replace("_", " ")}</span></div>

        {mode === "discover" && <><form onSubmit={discover} className="run-form discovery-form"><label htmlFor="goal">Goal</label><textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value.slice(0, 500))} required minLength={12} maxLength={500} /><label htmlFor="discovery-member-id">Invocation input</label><div className="input-row"><input id="discovery-member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" /><button type="submit" disabled={busy || memberId.length !== 5}>{discoveryStatus === "running" ? "Discovering…" : "Discover capability"}</button></div><p>Use <button type="button" className="inline-button" onClick={() => setMemberId("12345")}>12345</button> for success. Sensitive values stay local.</p></form><div className="result-card discovery-result" aria-live="polite"><p className="result-label">Discovery result</p>{!discoveryResult && <p className="empty-result">Submit a goal to start the constrained loop.</p>}{discoveryResult?.status === "success" && <div className="success-result"><strong>{discoveryResult.artifact.name}</strong><span>{discoveryResult.artifact.steps.length} actions · {discoveryResult.provider}</span><div className="result-actions"><button onClick={useGeneratedArtifact}>Replay generated artifact</button><button className="secondary" onClick={() => downloadJson(`${discoveryResult.artifact.name}.json`, discoveryResult.artifact)}>Download JSON</button></div></div>}{discoveryResult?.status === "business_outcome" && <div className="outcome-result"><strong>{discoveryResult.code}</strong><span>{discoveryResult.message}</span></div>}{discoveryResult?.status === "failure" && <div className="failure-result"><strong>{discoveryResult.error.code}</strong><span>Step {discoveryResult.error.step} · {discoveryResult.error.message}</span></div>}</div></>}

        {mode === "replay" && <><div className="artifact-source"><span>Artifact source</span><strong>{generatedArtifact ? `Generated or restored · ${artifactReview?.state ?? "draft"}` : "Bundled baseline · approved"}</strong><small>{activeArtifact.name}@{activeArtifact.version}</small></div><form onSubmit={replay} className="run-form"><label htmlFor="replay-member-id">Member ID input</label><div className="input-row"><input id="replay-member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" /><button type="submit" disabled={busy || memberId.length !== 5 || !artifactApproved}>{runStatus === "running" ? "Running…" : artifactApproved ? "Run capability" : "Approval required"}</button></div><label htmlFor="fault-mode">Fault injection</label><select id="fault-mode" className="policy-select" value={faultMode} onChange={(event) => setFaultMode(event.target.value as FaultMode)}><option value="none">None — normal execution</option><option value="session_expired">Auto-recover — session expired</option><option value="slow_load">Auto-recover — slow load timeout</option><option value="application_error">Stop — hard application error</option></select><p>Try <button type="button" className="inline-button" onClick={() => setMemberId("12345")}>12345</button> or <button type="button" className="inline-button" onClick={() => setMemberId("00000")}>00000</button>. Recovery is capped at one clean deterministic retry.</p></form><ResultCard result={replayResult} />{recoveryStatus && <div className={`recovery-summary ${recoveryStatus.recovered ? "recovered" : "settled"}`}><span>{recoveryStatus.recovered ? "Recovered" : "Policy settled"}</span><strong>{recoveryStatus.attempts} deterministic attempt{recoveryStatus.attempts === 1 ? "" : "s"}</strong><small>{recoveryStatus.recovered ? "The clean retry reached the declared checkpoint." : "No retry was needed or permitted."}</small></div>}</>}

        {mode === "handoff" && <div className="handoff-console">
          {handoff.owner === "automation" && <div className="handoff-intro"><p className="result-label">Assisted replay scenario</p><h4>Restricted-account acknowledgment</h4><p>Run the capability until it reaches an operator-only interstitial. The system will pause instead of bypassing it.</p><button onClick={startHandoff} disabled={busy || !artifactApproved}>{artifactApproved ? "Start assisted replay" : "Approval required"}</button></div>}
          {handoff.owner === "human_requested" && replayResult?.status === "human_required" && <div className="intervention-card"><span className="route-badge">Intervention routed</span><h4>{replayResult.intervention.code}</h4><p>{replayResult.intervention.message}</p><dl><div><dt>Stopped at</dt><dd>{replayResult.intervention.stepId}</dd></div><div><dt>Surface state</dt><dd>{replayResult.intervention.snapshot.visibleSignals.join(", ")}</dd></div></dl><button onClick={acceptHumanControl}>Accept control</button></div>}
          {handoff.owner === "human" && <div className="human-control-card"><span className="route-badge human">Human in control</span><h4>Operate the live session</h4><ol><li>Click <strong>Continue lookup</strong> inside the target session.</li><li>Return here and resume automation.</li></ol><p>{handoff.actions.length} redacted human action{handoff.actions.length === 1 ? "" : "s"} captured.</p><button onClick={resumeAutomation} disabled={handoff.actions.length === 0}>Resume automation</button></div>}
          {handoff.owner === "resuming" && <div className="handoff-intro"><p className="result-label">Control returned</p><h4>Revalidating the live session…</h4></div>}
          {handoff.owner === "completed" && <><div className="handoff-complete"><span className="route-badge complete">Handoff complete</span><h4>Automation resumed successfully</h4><p>The same session reached its checkpoint after {handoff.actions.length} recorded human action.</p><button onClick={() => { setHandoff(INITIAL_HANDOFF_STATE); setReplayResult(null); setReplayLogs([]); setRunStatus("idle"); }}>Run again</button></div><ResultCard result={replayResult} /></>}
        </div>}

        {mode === "catalog" && <div className="catalog-console">
          <div className="catalog-contract"><div><span className={`catalog-state ${catalogState}`}>{catalogState}</span><p className="result-label">GET /api/capabilities</p></div><h4>{catalogEntry?.name ?? "Capability catalog"}</h4><p>{catalogEntry?.description ?? "Loading the authenticated agent-facing contract…"}</p>{catalogEntry && <dl><div><dt>Version</dt><dd>{catalogEntry.version}</dd></div><div><dt>Risk</dt><dd>{catalogEntry.risk.replace("_", " ")}</dd></div><div><dt>Input</dt><dd>memberId · string</dd></div><div><dt>Outputs</dt><dd>{Object.keys(catalogEntry.outputs).join(", ")}</dd></div></dl>}</div>
          <div className="catalog-controls"><label htmlFor="catalog-variant">Reviewed tenant variant</label><select id="catalog-variant" className="policy-select" value={selectedVariant} onChange={(event) => setSelectedVariant(event.target.value)} disabled={busy || catalogState !== "ready"}>{catalogEntry?.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}</select><div className="variant-facts"><span>{catalogVariant?.vendorFamily ?? "vendor family pending"}</span><strong>{catalogVariant?.entryPoint ?? "—"}</strong><small>{catalogVariant?.reviewState ?? "unavailable"} override</small></div><label htmlFor="catalog-member-id">Typed invocation input</label><input id="catalog-member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" /><div className="catalog-actions"><button onClick={() => void invokeFromCatalog()} disabled={busy || catalogState !== "ready" || memberId.length !== 5}>Invoke capability</button><button className="secondary" onClick={() => void runStabilityCanary()} disabled={busy || catalogState !== "ready" || memberId.length !== 5}>Run 3-canary score</button></div></div>
          {activeTicket && <div className="ticket-card"><span>Invocation ticket</span><strong>{activeTicket.invocationId.slice(0, 13)}…</strong><small>{activeTicket.variant.id} · {activeTicket.capabilityName}@{activeTicket.capabilityVersion} · hash {activeTicket.artifactHash.slice(0, 10)}</small></div>}
          <ResultCard result={agentResult} />
          {stability && <div className={`stability-card ${stability.label}`}><div><span>Multi-run stability</span><strong>{stability.label.replace("_", " ")}</strong></div><b>{Math.round(stability.successRate * 100)}%</b><small>{stability.successfulRuns}/{stability.totalRuns} successful · {stability.recoveredRuns} recovered</small></div>}
        </div>}

        <div className="log-header"><span>{mode === "discover" ? "Discovery evidence" : mode === "handoff" ? "Handoff evidence" : mode === "catalog" ? "Agent invocation evidence" : "Replay evidence"}</span><span>{activeLogs.length} events</span></div><ol className="event-log phase-two-log">{activeLogs.length === 0 && <li className="log-empty">No evidence yet.</li>}{activeLogs.map((log, index) => <li key={`${log.time}-${index}`} className={log.state}><span className="log-marker" /><div><strong>{log.step}</strong><p>{log.detail}</p>{log.provider && <small>{log.provider}</small>}</div><time>{log.time}</time></li>)}</ol>
      </aside>
    </section>

    {generatedArtifact && <section className="artifact-inspector"><div><p className="section-kicker">Compiled capability</p><h3>{generatedArtifact.name}</h3><p>The transcript is discarded. Unattended replay stays blocked until the signed-in reviewer explicitly approves this exact artifact fingerprint.</p><div className={`approval-card ${artifactReview?.state ?? "draft"}`}><span>{artifactReview?.state ?? "draft"}</span><strong>{artifactReview?.state === "approved" ? "Approved for replay" : "Review required"}</strong>{artifactReview?.state !== "approved" && <button onClick={() => void registerArtifact(generatedArtifact, true)}>Approve exact artifact</button>}</div></div><dl><div><dt>Version</dt><dd>{generatedArtifact.version}</dd></div><div><dt>Steps</dt><dd>{generatedArtifact.steps.length}</dd></div><div><dt>Inputs</dt><dd>{Object.keys(generatedArtifact.inputs).join(", ")}</dd></div><div><dt>Outputs</dt><dd>{Object.keys(generatedArtifact.outputs).join(", ")}</dd></div></dl><pre>{JSON.stringify(generatedArtifact, null, 2)}</pre></section>}

    <section className="history-panel"><div><p className="section-kicker">Policy-backed audit trail</p><h3>Saved runs</h3><p>Evidence is redacted, owner-scoped, encrypted in hosted storage, integrity-checked, and automatically expired. Operators can delete a run immediately.</p><label className="retention-control" htmlFor="retention-days">New run retention<select id="retention-days" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value) as 7 | 30 | 90)}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label></div><div className="history-status"><span className={storageState}>{storageState}</span><button onClick={() => void loadHistory()}>Refresh</button></div><ol>{history.length === 0 && <li className="history-empty">{storageState === "loading" ? "Loading run history…" : storageState === "unavailable" ? "Durable storage is unavailable in this environment." : "No saved runs yet."}</li>}{history.map((run) => <li key={run.runId}><div><span className={`history-kind ${run.kind}`}>{run.kind}</span><strong>{run.artifactName}@{run.artifactVersion}</strong><small>{new Date(run.createdAt).toLocaleString()} · {run.encryption === "aes-gcm" ? `encrypted ${run.keyVersion ?? "managed"}` : "legacy plaintext"} · integrity {run.integrity}{run.evidenceHash ? ` ${run.evidenceHash.slice(0, 10)}` : ""} · expires {run.expiresAt ? new Date(run.expiresAt).toLocaleDateString() : "by policy"}</small></div><span className={`history-outcome ${run.status}`}>{run.status.replace("_", " ")}</span><div className="history-actions">{Boolean(run.artifact) && <button onClick={() => void restoreStoredArtifact(run)}>Use artifact</button>}<button className="delete" onClick={() => void deleteRun(run.runId)}>Delete</button></div></li>)}</ol></section>
  </main>;
}

function ResultCard({ result }: { result: ReplayResult | null }) {
  return <div className="result-card" aria-live="polite"><p className="result-label">Structured result</p>{!result && <p className="empty-result">Run the artifact without model decisions.</p>}{result?.status === "success" && <div className="success-result"><strong>{result.outputs.balance}</strong><span>Savings balance · {result.outputs.accountStatus}</span></div>}{result?.status === "business_outcome" && <div className="outcome-result"><strong>{result.code}</strong><span>{result.message}</span></div>}{result?.status === "failure" && <div className="failure-result"><strong>{result.error.code}</strong><span>{result.error.category} · step {result.error.stepId} · {result.error.message}</span></div>}{result?.status === "human_required" && <div className="outcome-result"><strong>human required</strong><span>{result.intervention.message}</span></div>}</div>;
}
