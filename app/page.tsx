"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import {
  AutomationError,
  HumanInterventionError,
  executeCapability,
  executeCapabilityWithRecovery,
  validateCapability,
  type ApprovalGrant,
  type Capability,
  type ControlTarget,
  type EvidenceEvent,
  type HumanAction,
  type Locator,
  type OutcomeDefinition,
  type ReplayResult,
  type ReplayResume,
  type SurfaceAdapter,
} from "@/lib/automation/core";
import {
  redactDiscoveryText,
  runDiscovery,
  type DiscoveryAdapter,
  type DiscoveryDecision,
  type DiscoveryEvidenceEvent,
  type DiscoveryResume,
  type DiscoveryResult,
  type ObservedControl,
} from "@/lib/discovery/core";
import { createAdaptiveDiscoveryProvider } from "@/lib/discovery/provider-client";
import { INITIAL_HANDOFF_STATE, transitionHandoff, type HandoffState } from "@/lib/handoff/core";
import type { CapabilityCatalogEntry, InvocationTicket, VerifiedInvocation } from "@/lib/automation/catalog";
import { scoreStability, type StabilityRun, type StabilityScore } from "@/lib/automation/stability";
import type { OperationalSnapshot } from "@/lib/operations/core";
import type { AutomationJob } from "@/lib/jobs/core";
import type { ArtifactReview, RunRecord, RunRecordInput } from "@/lib/persistence/contracts";

const savedCapability = validateCapability(rawCapability);
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

type Mode = "discover" | "replay" | "handoff" | "catalog";
type RunStatus = "idle" | "running" | ReplayResult["status"];
type DiscoveryStatus = "idle" | "running" | DiscoveryResult["status"];
type LogEntry = { time: string; step: string; detail: string; state: "ok" | "warn" | "error"; provider?: string };
type StoredRun = RunRecord;
type FaultMode = "none" | "session_expired" | "slow_load" | "application_error";
type RoleAssignment = { subject_id: string; role: string; assigned_by: string; updated_at: string };

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function getDocument(frame: HTMLIFrameElement) {
  const document = frame.contentDocument;
  if (!document) throw new AutomationError("target_unavailable", "recoverable", "The target application is not available.", true);
  return document;
}

function isElementVisible(element: Element) {
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0)) return false;
  return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
}

function isElementEnabled(element: Element) {
  if (element.closest("[inert], [aria-disabled='true']")) return false;
  return !("disabled" in element && Boolean((element as HTMLButtonElement | HTMLInputElement).disabled));
}

function findTarget(document: Document, target: ControlTarget, options: { requireEnabled?: boolean } = {}) {
  let ambiguousLocator: string | null = null;
  let disabledLocator: string | null = null;
  for (const candidate of target.locators) {
    let matches: Element[] = [];
    if (candidate.kind === "name") matches = [...document.querySelectorAll(`[name="${CSS.escape(candidate.value)}"]`)];
    if (candidate.kind === "css") matches = [...document.querySelectorAll(candidate.value)];
    if (candidate.kind === "button_text") {
      matches = [...document.querySelectorAll("button, input[type='submit']")].filter(
        (item) => (item.textContent?.trim() || item.getAttribute("value")) === candidate.value,
      );
    }
    const locator = `${candidate.kind}:${candidate.value}`;
    const visible = matches.filter(isElementVisible);
    const usable = options.requireEnabled ? visible.filter(isElementEnabled) : visible;
    if (usable.length === 1) return { element: usable[0], locator };
    if (usable.length > 1) ambiguousLocator = locator;
    if (options.requireEnabled && visible.length > 0 && usable.length === 0) disabledLocator = locator;
  }
  if (ambiguousLocator) throw new AutomationError("locator_ambiguous", "hard_failure", `Locator ${ambiguousLocator} matched multiple visible controls for ${target.description}.`);
  if (disabledLocator) throw new AutomationError("target_not_interactable", "hard_failure", `${target.description} is visible but disabled.`);
  return null;
}

function requireTarget(document: Document, target: ControlTarget, options: { requireEnabled?: boolean } = {}) {
  const found = findTarget(document, target, options);
  if (!found) throw new AutomationError("locator_not_found", "hard_failure", `No locator matched ${target.description}.`);
  return found;
}

async function reloadFrame(frame: HTMLIFrameElement, entryPoint: string, run: number, faultMode: FaultMode = "none") {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new AutomationError("target_timeout", "recoverable", "Target load timed out.", true)), 5000);
    frame.onload = () => {
      const readinessDeadline = Date.now() + 2000;
      let stableSince = 0;
      let priorSignature = "";
      const checkReady = () => {
        try {
          const document = frame.contentDocument;
          const interactive = document ? [...document.querySelectorAll("input, select, button")].filter(isElementVisible) : [];
          const signature = interactive.map((element) => `${element.tagName}:${element.getAttribute("name") ?? ""}:${element.textContent?.trim() ?? ""}:${isElementEnabled(element)}`).join("|");
          if (document?.readyState === "complete" && interactive.length >= 2 && signature === priorSignature) {
            if (!stableSince) stableSince = Date.now();
          } else {
            stableSince = 0;
            priorSignature = signature;
          }
          if (stableSince && Date.now() - stableSince >= 100) {
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
  const found = requireTarget(getDocument(frame), target, { requireEnabled: true });
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
  const found = requireTarget(getDocument(frame), target, { requireEnabled: true });
  (found.element as HTMLElement).click();
  return found.locator;
}

async function waitForOutcomes(frame: HTMLIFrameElement, outcomes: OutcomeDefinition[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const document = getDocument(frame);
    const visibleText = document.body.textContent ?? "";
    if (/OPERATOR SESSION EXPIRED/i.test(visibleText)) throw new AutomationError("session_expired", "recoverable", "The operator session expired before the result was available.", true);
    if (/CORE MEMBER SERVICES IS UNAVAILABLE/i.test(visibleText)) throw new AutomationError("application_unavailable", "hard_failure", "Core Member Services returned an application error.");
    if ([...document.querySelectorAll("[role='dialog']")].some(isElementVisible)) {
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
    async extract(target) {
      const found = requireTarget(getDocument(frame), target);
      return { value: found.element.textContent?.trim() ?? "", locator: found.locator };
    },
    async verify(target) { return Boolean(findTarget(getDocument(frame), target)); },
  };
}

function uniqueLocatorCandidates(document: Document, element: Element): Locator[] {
  const candidates: Locator[] = [];
  const add = (candidate: Locator) => {
    if (!candidates.some((item) => item.kind === candidate.kind && item.value === candidate.value)) candidates.push(candidate);
  };
  const name = element.getAttribute("name");
  if (name) add({ kind: "name", value: name });
  if (element.tagName === "BUTTON") {
    const text = element.textContent?.trim();
    if (text) add({ kind: "button_text", value: text });
  }
  if (element.id) add({ kind: "css", value: `#${CSS.escape(element.id)}` });
  for (const className of element.classList) {
    const selector = `.${CSS.escape(className)}`;
    if (document.querySelectorAll(selector).length === 1) add({ kind: "css", value: selector });
  }
  if (element.classList.length > 1) {
    const selector = [...element.classList].map((item) => `.${CSS.escape(item)}`).join("");
    if (document.querySelectorAll(selector).length === 1) add({ kind: "css", value: selector });
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body) {
    let part = current.tagName.toLowerCase();
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const sameTag = [...parentElement.children].filter((item) => item.tagName === current?.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    const selector = parts.join(" > ");
    if (document.querySelectorAll(selector).length === 1) add({ kind: "css", value: selector });
    current = parentElement;
  }
  return candidates.slice(0, 4);
}

function observedControl(document: Document, element: Element, index: number): ObservedControl | null {
  if (!isElementVisible(element)) return null;
  const clean = (value: string) => redactDiscoveryText(value.replace(/\s+/g, " ").trim()).slice(0, 180);
  let role: ObservedControl["role"];
  let name = "";
  let context = "";
  if (element.tagName === "INPUT") {
    role = "textbox";
    name = element.closest("tr")?.querySelector("th")?.textContent ?? element.getAttribute("name") ?? "Text input";
    context = "Editable field in the member inquiry form";
  } else if (element.tagName === "SELECT") {
    role = "combobox";
    name = element.closest("tr")?.querySelector("th")?.textContent ?? element.getAttribute("name") ?? "Selection";
    context = "Selection field in the member inquiry form";
  } else if (element.tagName === "BUTTON") {
    role = "button";
    name = element.textContent ?? "Button";
    context = element.closest("[role='dialog']") ? "Operator dialog action" : "Member inquiry action";
  } else if (element.getAttribute("role") === "dialog") {
    role = "dialog";
    name = element.querySelector(".legacy-dialog-title")?.textContent ?? "Operator dialog";
    context = element.querySelector("p")?.textContent ?? "Manual intervention surface";
  } else if (element.classList.contains("legacy-message")) {
    role = "status";
    name = element.textContent ?? "Application status";
    context = "Visible application outcome or error";
  } else if (element.classList.contains("member-result")) {
    role = "region";
    name = element.querySelector(".legacy-window-title")?.textContent ?? "Result region";
    context = "Visible member and account summary checkpoint";
  } else if (["TD", "TH"].includes(element.tagName)) {
    role = "text";
    const cell = element as HTMLTableCellElement;
    const table = element.closest("table");
    const header = table?.querySelectorAll("thead th")[cell.cellIndex]?.textContent ?? "Result";
    const description = element.parentElement?.children[1]?.textContent ?? "account row";
    name = `${header} cell`;
    context = `Account row: ${description}`;
  } else {
    return null;
  }
  const locatorCandidates = uniqueLocatorCandidates(document, element);
  if (locatorCandidates.length < 2) return null;
  return {
    ref: `control-${index + 1}`,
    role,
    name: clean(name),
    context: clean(context),
    visible: true,
    enabled: ["textbox", "combobox", "button"].includes(role) ? isElementEnabled(element) : undefined,
    filled: element.tagName === "INPUT" ? Boolean((element as HTMLInputElement).value) : undefined,
    hasValue: role === "text" ? Boolean(element.textContent?.trim()) : undefined,
    locatorCandidates,
  };
}

function discoverySurfaceSignature(document: Document) {
  return [...document.querySelectorAll("input, select, button, [role='dialog'], .legacy-message, .member-result, .accounts-grid tbody td")]
    .filter(isElementVisible)
    .map((element) => `${element.tagName}:${element.textContent?.replace(/\s+/g, " ").trim()}:${isElementEnabled(element)}`)
    .join("|");
}

async function waitForDiscoveryChange(frame: HTMLIFrameElement, timeoutMs: number) {
  const initial = discoverySurfaceSignature(getDocument(frame));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const document = getDocument(frame);
    const visibleText = document.body.textContent ?? "";
    if (/OPERATOR SESSION EXPIRED/i.test(visibleText)) throw new AutomationError("session_expired", "recoverable", "The operator session expired during discovery.", true);
    if (/CORE MEMBER SERVICES IS UNAVAILABLE/i.test(visibleText)) throw new AutomationError("application_unavailable", "hard_failure", "Core Member Services returned an application error.");
    if (discoverySurfaceSignature(document) !== initial) return;
    await pause(100);
  }
  throw new AutomationError("outcome_timeout", "recoverable", "The live surface did not change before the discovery timeout.", true);
}

function createDiscoveryAdapter(frame: HTMLIFrameElement, nextRun: () => number): DiscoveryAdapter {
  return {
    prepare: (entryPoint) => reloadFrame(frame, entryPoint, nextRun()),
    currentUrl: () => currentFrameUrl(frame),
    async observe() {
      const document = getDocument(frame);
      const elements = [...document.querySelectorAll("input, select, button, [role='dialog'], .legacy-message, .member-result, .accounts-grid tbody td")];
      const controls = elements.map((element, index) => observedControl(document, element, index)).filter((control): control is ObservedControl => Boolean(control));
      return { url: currentFrameUrl(frame), title: document.title || "Northstar Core Member Services", controls };
    },
    async execute(decision: DiscoveryDecision, inputs: Record<string, string>) {
      if (decision.action === "wait_for_change") {
        await waitForDiscoveryChange(frame, 5000);
        return {};
      }
      if (!decision.target) throw new AutomationError("model_contract_invalid", "hard_failure", "Decision target is missing.");
      if (decision.action === "type") {
        if (!decision.input) throw new AutomationError("model_contract_invalid", "hard_failure", "Decision input is missing.");
        return { locator: await typeIntoTarget(frame, decision.target, inputs[decision.input]) };
      }
      if (decision.action === "click") return { locator: await clickTarget(frame, decision.target) };
      if (decision.action === "extract") {
        const found = requireTarget(getDocument(frame), decision.target);
        const value = found.element.textContent?.trim() ?? "";
        if (!value) throw new AutomationError("output_missing", "hard_failure", `${decision.output} was empty.`);
        return { value, locator: found.locator };
      }
      throw new AutomationError("model_contract_invalid", "hard_failure", "Complete actions are verified by the discovery engine.");
    },
    async verify(target) { return Boolean(findTarget(getDocument(frame), target)); },
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
  return { time: formatTime(event.at), step: `${String(event.step).padStart(2, "0")} · ${event.phase}`, detail: event.detail, state: event.outcome === "error" ? "error" : ["business_outcome", "intervention"].includes(event.outcome) ? "warn" : "ok", provider: event.provider };
}
function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const runCounterRef = useRef(0);
  const resumeRef = useRef<ReplayResume | null>(null);
  const discoveryResumeRef = useRef<DiscoveryResume | null>(null);
  const stopHumanCaptureRef = useRef<(() => void) | null>(null);
  const handoffJobRef = useRef<string | null>(null);
  const handoffInvocationRef = useRef<VerifiedInvocation | null>(null);
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
  const [operations, setOperations] = useState<OperationalSnapshot | null>(null);
  const [rotationState, setRotationState] = useState<"idle" | "running" | "complete" | "unavailable">("idle");
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [jobState, setJobState] = useState<"idle" | "running">("idle");
  const [governance, setGovernance] = useState<{ subjectId: string; role: string; capabilities: string[]; assignments: RoleAssignment[] } | null>(null);
  const [scheduler, setScheduler] = useState<{ scheduler: string; webhookConfigured: boolean } | null>(null);
  const [reviewQueue, setReviewQueue] = useState<ArtifactReview[]>([]);
  const [roleSubject, setRoleSubject] = useState("");
  const [roleValue, setRoleValue] = useState("reviewer");
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

  async function loadOperations() {
    try {
      const response = await fetch("/api/operations", { cache: "no-store" });
      if (!response.ok) throw new Error("operations unavailable");
      const body = await response.json() as { snapshot: OperationalSnapshot };
      setOperations(body.snapshot);
    } catch { setOperations(null); }
  }
  async function loadJobs() {
    try { const response = await fetch("/api/jobs", { cache: "no-store" }); if (!response.ok) throw new Error(); const body = await response.json() as { jobs: AutomationJob[] }; setJobs(body.jobs); }
    catch { setJobs([]); }
  }
  async function loadGovernance() { try { const [roles, schedule, reviews] = await Promise.all([fetch("/api/roles", { cache: "no-store" }), fetch("/api/scheduler", { cache: "no-store" }), fetch("/api/artifacts", { cache: "no-store" })]); if (roles.ok) setGovernance(await roles.json()); if (schedule.ok) setScheduler(await schedule.json()); if (reviews.ok) { const body = await reviews.json() as { reviews: ArtifactReview[] }; setReviewQueue(body.reviews); } } catch { setGovernance(null); setScheduler(null); setReviewQueue([]); } }
  async function runScheduler() { await fetch("/api/scheduler", { method: "POST" }); await loadGovernance(); await loadOperations(); await loadJobs(); }
  async function assignRole() { if (!roleSubject.trim()) return; const response = await fetch("/api/roles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjectId: roleSubject.trim(), role: roleValue }) }); if (response.ok) { setRoleSubject(""); await loadGovernance(); } }
  async function decideArtifactReview(artifactHash: string, decision: "approve" | "reject") { const response = await fetch("/api/artifacts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artifactHash, decision }) }); if (response.ok) { const body = await response.json() as { review: ArtifactReview }; if (artifactReview?.artifactHash === body.review.artifactHash) setArtifactReview(body.review); await loadGovernance(); } }
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadHistory(); void loadCatalog(); void loadOperations(); void loadJobs(); void loadGovernance(); }, 0);
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
      const response = await fetch("/api/artifacts", { method: approve ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artifact, decision: approve ? "approve" : undefined }) });
      if (!response.ok) throw new Error("review failed");
      const body = await response.json() as { review: ArtifactReview };
      setArtifactReview(body.review);
      return body.review;
    } catch { setStorageState("unavailable"); return null; }
  }

  function approvalGrant(review: ArtifactReview | null): ApprovalGrant | undefined {
    if (!review || review.state !== "approved" || !review.reviewedAt) return undefined;
    return {
      artifactHash: review.artifactHash,
      state: "approved",
      approvals: review.approvals,
      requiredApprovals: review.requiredApprovals,
      rejections: review.rejections,
      approvedAt: review.reviewedAt,
    };
  }

  async function discover(event: FormEvent) {
    event.preventDefault(); const frame = frameRef.current; if (!frame || busy) return;
    stopHumanCaptureRef.current?.(); stopHumanCaptureRef.current = null; discoveryResumeRef.current = null; setHandoff(INITIAL_HANDOFF_STATE);
    setDiscoveryStatus("running"); setDiscoveryLogs([]); setDiscoveryResult(null); setGeneratedArtifact(null);
    const result = await runDiscovery({ goal, inputs: { memberId }, origin: window.location.origin, provider: createAdaptiveDiscoveryProvider(), adapter: createDiscoveryAdapter(frame, () => ++runCounterRef.current), onEvidence: (evidence) => setDiscoveryLogs((items) => [...items, toDiscoveryLog(evidence)]) });
    if (result.status === "success") { setGeneratedArtifact(result.artifact); await registerArtifact(result.artifact); }
    if (result.status === "human_required") {
      discoveryResumeRef.current = result.resume;
      setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId }));
    }
    setDiscoveryResult(result); setDiscoveryStatus(result.status);
    await persistRun({ runId: result.runId, kind: "discovery", status: result.status, artifactName: result.status === "success" ? result.artifact.name : "get_savings_balance", artifactVersion: result.status === "success" ? result.artifact.version : savedCapability.version, provider: result.provider, summary: { eventCount: result.evidence.length, outcome: result.status }, evidence: result.evidence, artifact: result.status === "success" ? result.artifact : undefined });
  }

  async function resumeDiscovery() {
    const frame = frameRef.current; const resume = discoveryResumeRef.current; if (!frame || !resume || handoff.owner !== "human") return;
    stopHumanCaptureRef.current?.(); stopHumanCaptureRef.current = null;
    setHandoff((state) => transitionHandoff(state, { type: "resume" })); setDiscoveryStatus("running");
    const result = await runDiscovery({
      goal,
      inputs: { memberId },
      origin: window.location.origin,
      provider: createAdaptiveDiscoveryProvider(),
      adapter: createDiscoveryAdapter(frame, () => ++runCounterRef.current),
      resume,
      humanActions: handoff.actions,
      onEvidence: (evidence) => setDiscoveryLogs((items) => [...items, toDiscoveryLog(evidence)]),
    });
    setDiscoveryLogs(result.evidence.map(toDiscoveryLog)); setDiscoveryResult(result); setDiscoveryStatus(result.status);
    if (result.status === "success") {
      discoveryResumeRef.current = null; setGeneratedArtifact(result.artifact); await registerArtifact(result.artifact);
      setHandoff((state) => transitionHandoff(state, { type: "complete" }));
    } else if (result.status === "human_required") {
      discoveryResumeRef.current = result.resume;
      setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId }));
    } else {
      discoveryResumeRef.current = null;
      setHandoff((state) => transitionHandoff(state, { type: "complete" }));
    }
    await persistRun({ runId: result.runId, kind: "discovery", status: result.status, artifactName: result.status === "success" ? result.artifact.name : "get_savings_balance", artifactVersion: result.status === "success" ? result.artifact.version : savedCapability.version, provider: result.provider, summary: { eventCount: result.evidence.length, outcome: result.status, humanActionCount: handoff.actions.length }, evidence: result.evidence, artifact: result.status === "success" ? result.artifact : undefined });
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
      approvalGrant: approvalGrant(artifactReview),
      onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]),
    });
    const result = execution.result;
    setRecoveryStatus({ attempts: execution.attempts, recovered: execution.recovered });
    setReplayResult(result); setRunStatus(result.status);
    if (result.status !== "human_required") await persistRun({ runId: result.runId, kind: "replay", status: result.status, artifactName: activeArtifact.name, artifactVersion: activeArtifact.version, summary: { eventCount: result.evidence.length, outcome: result.status, attempts: execution.attempts, recovered: execution.recovered }, evidence: result.evidence, artifact: activeArtifact });
  }

  async function requestInvocationTicket(): Promise<VerifiedInvocation> {
    const response = await fetch("/api/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilityName: savedCapability.name, version: savedCapability.version, variantId: selectedVariant, inputs: { memberId } }),
    });
    if (!response.ok) throw new AutomationError("invocation_rejected", "invalid_request", "The catalog rejected this invocation.");
    const body = await response.json() as { ticket: InvocationTicket };
    setActiveTicket(body.ticket);
    const verification = await fetch("/api/capabilities", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: body.ticket }) });
    if (!verification.ok) throw new AutomationError("ticket_verification_failed", "policy_denied", "The signed invocation ticket could not be verified.");
    const verified = await verification.json() as { verified: true; invocation: VerifiedInvocation };
    return verified.invocation;
  }

  async function verifyTicket(ticket: InvocationTicket): Promise<VerifiedInvocation> {
    setActiveTicket(ticket);
    const response = await fetch("/api/capabilities", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
    if (!response.ok) throw new AutomationError("ticket_verification_failed", "policy_denied", "The signed invocation ticket could not be verified.");
    return ((await response.json()) as { invocation: VerifiedInvocation }).invocation;
  }

  async function claimJob(jobId: string) {
    const response = await fetch("/api/jobs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "claim", jobId }) });
    if (!response.ok) throw new Error("job claim failed");
    const body = await response.json() as { ticket: InvocationTicket };
    return verifyTicket(body.ticket);
  }

  async function updateJob(jobId: string, status: ReplayResult["status"], result: ReplayResult) {
    await fetch("/api/jobs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete", jobId, status, result: { runId: result.runId, status: result.status } }) });
    await loadJobs(); await loadOperations();
  }

  async function enqueueJob() {
    if (jobState === "running" || memberId.length !== 5) return;
    setJobState("running");
    try { await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilityName: savedCapability.name, version: savedCapability.version, variantId: selectedVariant, inputs: { memberId } }) }); await loadJobs(); await loadOperations(); }
    finally { setJobState("idle"); }
  }

  async function runJob(job: AutomationJob) {
    if (jobState === "running") return; setJobState("running"); setAgentStatus("running"); setAgentLogs([]);
    try { const invocation = await claimJob(job.jobId); const executed = await executeAgentTicket(invocation, "job"); setAgentResult(executed.result); setAgentStatus(executed.result.status); await updateJob(job.jobId, executed.result.status, executed.result); }
    catch { setAgentStatus("failure"); await loadJobs(); }
    finally { setJobState("idle"); }
  }

  async function rehydrateIntervention(job: AutomationJob) {
    const frame = frameRef.current; if (!frame || jobState === "running") return;
    setJobState("running");
    try {
      const invocation = await claimJob(job.jobId); handoffJobRef.current = job.jobId; handoffInvocationRef.current = invocation;
      setMemberId(invocation.inputs.memberId); setMode("handoff"); setHandoff(INITIAL_HANDOFF_STATE); setReplayLogs([]); setRunStatus("running");
      const result = await executeCapability({ artifact: invocation.artifact, inputs: invocation.inputs, origin: window.location.origin, adapter: createReplayAdapter(frame, () => ++runCounterRef.current), onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]) });
      setReplayResult(result); setRunStatus(result.status);
      if (result.status === "human_required") { resumeRef.current = result.resume; setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId })); await updateJob(job.jobId, "human_required", result); }
      else await updateJob(job.jobId, result.status, result);
    } finally { setJobState("idle"); }
  }

  async function executeAgentTicket(ticket: VerifiedInvocation, runLabel: string): Promise<{ result: ReplayResult; stabilityRun: StabilityRun }> {
    const frame = frameRef.current;
    if (!frame) throw new AutomationError("target_unavailable", "recoverable", "The target application is not available.", true);
    const execution = await executeCapabilityWithRecovery({
      artifact: ticket.artifact,
      inputs: ticket.inputs,
      origin: window.location.origin,
      runId: ticket.invocationId,
      createAdapter: () => createReplayAdapter(frame, () => ++runCounterRef.current),
      maxAttempts: 2,
      approvalGrant: approvalGrant(artifactReview),
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
    await loadOperations();
    return { result, stabilityRun: { status: result.status, attempts: execution.attempts, recovered: execution.recovered } };
  }

  async function invokeFromCatalog() {
    if (busy || memberId.length !== 5) return;
    setAgentStatus("running"); setAgentLogs([]); setAgentResult(null); setStability(null);
    try {
      const ticket = await requestInvocationTicket();
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

  async function rotateEvidence() {
    if (rotationState === "running") return;
    setRotationState("running");
    try {
      const response = await fetch("/api/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rotate_evidence" }) });
      if (!response.ok) throw new Error("rotation unavailable");
      setRotationState("complete"); await loadHistory(); await loadOperations();
    } catch { setRotationState("unavailable"); }
  }

  async function startHandoff() {
    const frame = frameRef.current; if (!frame || busy) return;
    if (!artifactApproved || (generatedArtifact && (await registerArtifact(generatedArtifact))?.state !== "approved")) return;
    stopHumanCaptureRef.current?.(); resumeRef.current = null; handoffJobRef.current = null; handoffInvocationRef.current = null; setMemberId("31415"); setHandoff(INITIAL_HANDOFF_STATE);
    setRunStatus("running"); setReplayLogs([]); setReplayResult(null);
    const result = await executeCapability({ artifact: activeArtifact, inputs: { memberId: "31415" }, origin: window.location.origin, adapter: createReplayAdapter(frame, () => ++runCounterRef.current), approvalGrant: approvalGrant(artifactReview), onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]) });
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
    const jobInvocation = handoffInvocationRef.current;
    const result = await executeCapability({ artifact: jobInvocation?.artifact ?? activeArtifact, inputs: jobInvocation?.inputs ?? { memberId: "31415" }, origin: window.location.origin, adapter: createReplayAdapter(frame, () => ++runCounterRef.current), resume, humanActions: handoff.actions, approvalGrant: approvalGrant(artifactReview), onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]) });
    setReplayLogs(result.evidence.map(toReplayLog)); setReplayResult(result); setRunStatus(result.status);
    if (result.status === "success") setHandoff((state) => transitionHandoff(state, { type: "complete" }));
    const completedArtifact = jobInvocation?.artifact ?? activeArtifact;
    await persistRun({ runId: result.runId, kind: "handoff", status: result.status === "human_required" ? "failure" : result.status, artifactName: completedArtifact.name, artifactVersion: completedArtifact.version, summary: { eventCount: result.evidence.length, outcome: result.status, humanActionCount: handoff.actions.length, jobId: handoffJobRef.current }, evidence: result.evidence, artifact: completedArtifact });
    if (handoffJobRef.current) await updateJob(handoffJobRef.current, result.status === "human_required" ? "failure" : result.status, result);
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

    <section className="overview-grid phase-two-overview"><div><p className="section-kicker">Phase 10 · Approval control</p><h2>Require independent review when risk increases.</h2><p className="lede">Capability approval is now a durable team workflow. Safe read-only artifacts keep a light review path; risky artifacts require two distinct reviewers and block self-approval.</p></div><dl className="capability-facts"><div><dt>Policy</dt><dd>Risk-derived quorum</dd></div><div><dt>Control</dt><dd>No risky self-approval</dd></div><div><dt>Decisions</dt><dd>Durable audit trail</dd></div><div><dt>Admin</dt><dd>Role assignments</dd></div></dl></section>

    <nav className="mode-switch" aria-label="Automation mode">
      <button className={mode === "discover" ? "active" : ""} onClick={() => setMode("discover")} disabled={busy}><span>01</span> Discover</button>
      <button className={mode === "replay" ? "active" : ""} onClick={() => setMode("replay")} disabled={busy}><span>02</span> Replay</button>
      <button className={mode === "handoff" ? "active" : ""} onClick={() => setMode("handoff")} disabled={busy}><span>03</span> Human handoff</button>
      <button className={mode === "catalog" ? "active" : ""} onClick={() => setMode("catalog")} disabled={busy}><span>04</span> Agent API</button>
    </nav>

    <section className="workspace-grid">
      <div className="panel target-panel"><div className="panel-heading"><div><span className="panel-number">LIVE</span><h3>Target session</h3></div><a href="/legacy" target="_blank" rel="noreferrer">Open manually ↗</a></div><div className={`ownership-strip ${handoff.owner}`}><span>Control</span><strong>{mode === "handoff" || (mode === "discover" && handoff.owner !== "automation") ? handoff.owner.replace("_", " ") : "automation"}</strong><small>Same session retained</small></div><div className="browser-frame"><div className="browser-bar"><span /><span /><span /><div className="address-bar">allowlisted / legacy / member-services</div></div><iframe ref={frameRef} title="Legacy credit union member portal" src="/legacy?embedded=1" /></div></div>

      <aside className="panel run-panel"><div className="panel-heading"><div><span className="panel-number">{mode === "discover" ? "AI" : mode === "replay" ? "DET" : mode === "handoff" ? "HITL" : "API"}</span><h3>{mode === "discover" ? "Goal-driven discovery" : mode === "replay" ? "Deterministic replay" : mode === "handoff" ? "Intervention control" : "Agent capability catalog"}</h3></div><span className={`status-pill ${activeStatus}`}>{String(activeStatus).replace("_", " ")}</span></div>

        {mode === "discover" && <><form onSubmit={discover} className="run-form discovery-form"><label htmlFor="goal">Goal</label><textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value.slice(0, 500))} required minLength={12} maxLength={500} /><p>Supported intent: read-only member savings balance and account-status lookup.</p><label htmlFor="discovery-member-id">Invocation input</label><div className="input-row"><input id="discovery-member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" /><button type="submit" disabled={busy || ["human_requested", "human", "resuming"].includes(handoff.owner) || memberId.length !== 5}>{discoveryStatus === "running" ? "Discovering…" : "Discover capability"}</button></div><p>Use <button type="button" className="inline-button" onClick={() => setMemberId("12345")}>12345</button> for success or <button type="button" className="inline-button" onClick={() => setMemberId("31415")}>31415</button> to verify discovery handoff. Sensitive values stay local.</p></form><div className="result-card discovery-result" aria-live="polite"><p className="result-label">Discovery result</p>{!discoveryResult && <p className="empty-result">Submit a goal to start the constrained loop.</p>}{discoveryResult?.status === "success" && <div className="success-result"><strong>{discoveryResult.artifact.name}</strong><span>{discoveryResult.artifact.steps.length} actions · {discoveryResult.provider}</span><div className="result-actions"><button onClick={useGeneratedArtifact}>Replay generated artifact</button><button className="secondary" onClick={() => downloadJson(`${discoveryResult.artifact.name}.json`, discoveryResult.artifact)}>Download JSON</button></div></div>}{discoveryResult?.status === "human_required" && handoff.owner === "human_requested" && <div className="intervention-card"><span className="route-badge">Intervention routed</span><h4>{discoveryResult.intervention.code}</h4><p>{discoveryResult.intervention.message}</p><dl><div><dt>Stopped at</dt><dd>Discovery step {discoveryResult.intervention.step}</dd></div><div><dt>Surface state</dt><dd>{discoveryResult.intervention.snapshot.visibleSignals.join(", ")}</dd></div></dl><button onClick={acceptHumanControl}>Accept discovery control</button></div>}{discoveryResult?.status === "human_required" && handoff.owner === "human" && <div className="human-control-card"><span className="route-badge human">Human in control</span><h4>Operate the live session</h4><ol><li>Click <strong>Continue lookup</strong> inside the target session.</li><li>Return here and resume discovery.</li></ol><p>{handoff.actions.length} redacted human action{handoff.actions.length === 1 ? "" : "s"} captured.</p><button onClick={resumeDiscovery} disabled={handoff.actions.length === 0}>Resume discovery</button></div>}{handoff.owner === "resuming" && <div className="handoff-intro"><p className="result-label">Control returned</p><h4>Revalidating discovery…</h4></div>}{discoveryResult?.status === "business_outcome" && <div className="outcome-result"><strong>{discoveryResult.code}</strong><span>{discoveryResult.message}</span></div>}{discoveryResult?.status === "failure" && <div className="failure-result"><strong>{discoveryResult.error.code}</strong><span>Step {discoveryResult.error.step} · {discoveryResult.error.message}</span></div>}</div></>}

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
          {activeTicket && <div className="ticket-card"><span>Signed invocation ticket</span><strong>{activeTicket.signature.slice(0, 13)}…</strong><small>{activeTicket.variant.id} · expires {formatTime(activeTicket.expiresAt)} · hash {activeTicket.artifactHash.slice(0, 10)}</small></div>}
          <ResultCard result={agentResult} />
          {stability && <div className={`stability-card ${stability.label}`}><div><span>Multi-run stability</span><strong>{stability.label.replace("_", " ")}</strong></div><b>{Math.round(stability.successRate * 100)}%</b><small>{stability.successfulRuns}/{stability.totalRuns} successful · {stability.recoveredRuns} recovered</small></div>}
          <div className="jobs-card"><div className="operations-heading"><div><span>Durable job queue</span><strong>{jobs.filter((job) => ["queued", "human_required"].includes(job.status)).length} waiting</strong></div><button onClick={() => void enqueueJob()} disabled={jobState === "running"}>{jobState === "running" ? "Working…" : "Enqueue current"}</button></div><ol>{jobs.length === 0 && <li className="job-empty">No durable jobs yet.</li>}{jobs.slice(0, 6).map((job) => <li key={job.jobId}><div><strong>{job.variantId}</strong><small>{job.status.replace("_", " ")} · {new Date(job.createdAt).toLocaleTimeString()}</small></div>{job.status === "queued" && <button onClick={() => void runJob(job)}>Run</button>}{job.status === "human_required" && <button onClick={() => void rehydrateIntervention(job)}>Rehydrate</button>}</li>)}</ol></div>
          <div className="operations-card"><div className="operations-heading"><div><span>24-hour operations</span><strong>{operations ? `${Math.round(operations.successRate * 100)}% success` : "Loading telemetry"}</strong></div><button onClick={() => { void loadOperations(); void loadJobs(); }}>Refresh</button></div>{operations && operations.alerts.length > 0 && <div className="alert-stack">{operations.alerts.map((alert) => <p key={alert.code} className={alert.severity}><strong>{alert.code.replaceAll("_", " ")}</strong><span>{alert.message}</span></p>)}</div>}{operations?.alerts.length === 0 && <div className="all-clear">No active operational alerts.</div>}<dl><div><dt>Issued / verified</dt><dd>{operations ? `${operations.ticketsIssued} / ${operations.ticketsVerified}` : "—"}</dd></div><div><dt>Rejected / limited</dt><dd>{operations ? `${operations.ticketsRejected} / ${operations.rateLimited}` : "—"}</dd></div><div><dt>Queued jobs</dt><dd>{operations?.queuedJobs ?? "—"}</dd></div><div><dt>Interventions</dt><dd>{operations?.humanRequiredJobs ?? "—"}</dd></div></dl><div className="key-rotation"><span>Evidence key {operations?.currentKeyVersion ?? "managed"}</span><small>{operations?.staleEvidenceRows ?? 0} rows awaiting rotation</small><button onClick={() => void rotateEvidence()} disabled={!operations || operations.staleEvidenceRows === 0 || !operations.previousKeyConfigured || rotationState === "running"}>{rotationState === "running" ? "Rotating…" : operations?.staleEvidenceRows ? "Rotate evidence" : "Rotation current"}</button></div></div>
          <div className="governance-card"><div><span>Signed-in authority</span><strong>{governance?.role ?? "loading"}</strong><small>{governance?.capabilities.join(" · ") ?? "Resolving server policy"}</small></div><div><span>Scheduler</span><strong>{scheduler?.scheduler ?? "loading"}</strong><small>{scheduler?.webhookConfigured ? "External webhook configured" : "Webhook destination not configured"}</small></div><button onClick={() => void runScheduler()} disabled={!governance?.capabilities.includes("dispatch_alerts")}>Run control tick</button></div>
          {governance?.capabilities.includes("manage_roles") && <div className="role-admin-card"><div><span>Administrator</span><strong>Assign team authority</strong><small>Use the authenticated Site user id for an existing granted visitor.</small></div><input aria-label="Authenticated user id" placeholder="Authenticated user id" value={roleSubject} onChange={(event) => setRoleSubject(event.target.value.slice(0, 120))} /><select aria-label="Automation role" value={roleValue} onChange={(event) => setRoleValue(event.target.value)}><option value="reviewer">Reviewer</option><option value="operator">Operator</option><option value="agent">Agent</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select><button onClick={() => void assignRole()} disabled={!roleSubject.trim()}>Assign</button>{governance.assignments.slice(0, 4).map((item) => <p key={item.subject_id}><strong>{item.role}</strong><span>{item.subject_id}</span></p>)}</div>}
          {governance?.capabilities.includes("review_artifacts") && <div className="review-queue-card"><div className="operations-heading"><div><span>Reviewer queue</span><strong>{reviewQueue.filter((item) => item.state !== "approved").length} open</strong></div><button onClick={() => void loadGovernance()}>Refresh</button></div><ol>{reviewQueue.length === 0 && <li className="job-empty">No submitted artifacts.</li>}{reviewQueue.slice(0, 5).map((item) => <li key={item.artifactHash}><div><strong>{item.artifactName}@{item.artifactVersion}</strong><small>{item.riskClass.replace("_", " ")} · {item.approvals}/{item.requiredApprovals} approvals · {item.state}</small></div>{item.state !== "approved" && item.canDecide && <div className="review-actions"><button onClick={() => void decideArtifactReview(item.artifactHash, "approve")}>Approve</button><button className="reject" onClick={() => void decideArtifactReview(item.artifactHash, "reject")}>Reject</button></div>}</li>)}</ol></div>}
        </div>}

        <div className="log-header"><span>{mode === "discover" ? "Discovery evidence" : mode === "handoff" ? "Handoff evidence" : mode === "catalog" ? "Agent invocation evidence" : "Replay evidence"}</span><span>{activeLogs.length} events</span></div><ol className="event-log phase-two-log">{activeLogs.length === 0 && <li className="log-empty">No evidence yet.</li>}{activeLogs.map((log, index) => <li key={`${log.time}-${index}`} className={log.state}><span className="log-marker" /><div><strong>{log.step}</strong><p>{log.detail}</p>{log.provider && <small>{log.provider}</small>}</div><time>{log.time}</time></li>)}</ol>
      </aside>
    </section>

    {generatedArtifact && <section className="artifact-inspector"><div><p className="section-kicker">Compiled capability</p><h3>{generatedArtifact.name}</h3><p>The transcript is discarded. Approval is fingerprint-bound; risky capabilities require independent reviewers before unattended replay.</p><div className={`approval-card ${artifactReview?.state ?? "draft"}`}><span>{artifactReview?.state ?? "draft"}</span><strong>{artifactReview?.state === "approved" ? "Approved for replay" : `${artifactReview?.approvals ?? 0}/${artifactReview?.requiredApprovals ?? 1} approvals`}</strong>{artifactReview?.state !== "approved" && artifactReview?.canDecide && <button onClick={() => void registerArtifact(generatedArtifact, true)}>Approve exact artifact</button>}<small>{artifactReview?.separationRequired ? "Two independent reviewers required; submitter cannot approve." : "Read-only policy uses one reviewer."}</small></div></div><dl><div><dt>Version</dt><dd>{generatedArtifact.version}</dd></div><div><dt>Risk</dt><dd>{generatedArtifact.policy.risk.replace("_", " ")}</dd></div><div><dt>Steps</dt><dd>{generatedArtifact.steps.length}</dd></div><div><dt>Inputs</dt><dd>{Object.keys(generatedArtifact.inputs).join(", ")}</dd></div><div><dt>Outputs</dt><dd>{Object.keys(generatedArtifact.outputs).join(", ")}</dd></div><div><dt>Review quorum</dt><dd>{artifactReview?.requiredApprovals ?? 1}</dd></div></dl><pre>{JSON.stringify(generatedArtifact, null, 2)}</pre></section>}

    <section className="history-panel"><div><p className="section-kicker">Policy-backed audit trail</p><h3>Saved runs</h3><p>Evidence is redacted, owner-scoped, encrypted in hosted storage, integrity-checked, and automatically expired. Operators can delete a run immediately.</p><label className="retention-control" htmlFor="retention-days">New run retention<select id="retention-days" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value) as 7 | 30 | 90)}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label></div><div className="history-status"><span className={storageState}>{storageState}</span><button onClick={() => void loadHistory()}>Refresh</button></div><ol>{history.length === 0 && <li className="history-empty">{storageState === "loading" ? "Loading run history…" : storageState === "unavailable" ? "Durable storage is unavailable in this environment." : "No saved runs yet."}</li>}{history.map((run) => <li key={run.runId}><div><span className={`history-kind ${run.kind}`}>{run.kind}</span><strong>{run.artifactName}@{run.artifactVersion}</strong><small>{new Date(run.createdAt).toLocaleString()} · {run.encryption === "aes-gcm" ? `encrypted ${run.keyVersion ?? "managed"}` : "legacy plaintext"} · integrity {run.integrity}{run.evidenceHash ? ` ${run.evidenceHash.slice(0, 10)}` : ""} · expires {run.expiresAt ? new Date(run.expiresAt).toLocaleDateString() : "by policy"}</small></div><span className={`history-outcome ${run.status}`}>{run.status.replace("_", " ")}</span><div className="history-actions">{Boolean(run.artifact) && <button onClick={() => void restoreStoredArtifact(run)}>Use artifact</button>}<button className="delete" onClick={() => void deleteRun(run.runId)}>Delete</button></div></li>)}</ol></section>
  </main>;
}

function ResultCard({ result }: { result: ReplayResult | null }) {
  return <div className="result-card" aria-live="polite"><p className="result-label">Structured result</p>{!result && <p className="empty-result">Run the artifact without model decisions.</p>}{result?.status === "success" && <div className="success-result"><strong>{result.outputs.balance}</strong><span>Savings balance · {result.outputs.accountStatus}</span></div>}{result?.status === "business_outcome" && <div className="outcome-result"><strong>{result.code}</strong><span>{result.message}</span></div>}{result?.status === "failure" && <div className="failure-result"><strong>{result.error.code}</strong><span>{result.error.category} · step {result.error.stepId} · {result.error.message}</span></div>}{result?.status === "human_required" && <div className="outcome-result"><strong>human required</strong><span>{result.intervention.message}</span></div>}</div>;
}
