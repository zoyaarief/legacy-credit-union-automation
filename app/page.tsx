"use client";

import { FormEvent, useRef, useState } from "react";
import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import {
  AutomationError,
  executeCapability,
  validateCapability,
  type ControlTarget,
  type EvidenceEvent,
  type OutcomeDefinition,
  type ReplayResult,
  type SurfaceAdapter,
} from "@/lib/automation/core";

const capability = validateCapability(rawCapability);
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

type RunStatus = "idle" | "running" | ReplayResult["status"];
type LogEntry = { time: string; step: string; detail: string; state: "ok" | "warn" | "error" };

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
  if (!found) {
    throw new AutomationError("locator_not_found", "hard_failure", `No locator matched ${target.description}.`);
  }
  return found;
}

function createIframeAdapter(frame: HTMLIFrameElement, nextRun: () => number): SurfaceAdapter {
  return {
    async prepare(entryPoint) {
      const run = nextRun();
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new AutomationError("target_timeout", "recoverable", "Target load timed out.", true)),
          5000,
        );
        frame.onload = () => {
          window.clearTimeout(timer);
          resolve();
        };
        frame.src = `${entryPoint}?embedded=1&run=${run}`;
      });
    },
    currentUrl() {
      try {
        return frame.contentWindow?.location.href ?? "";
      } catch {
        throw new AutomationError("policy_denied", "policy_denied", "The live surface became cross-origin.");
      }
    },
    async type(target, value) {
      const targetDocument = getDocument(frame);
      const found = requireTarget(targetDocument, target);
      const input = found.element as HTMLInputElement;
      const targetWindow = frame.contentWindow;
      if (!targetWindow) throw new AutomationError("target_unavailable", "recoverable", "The target window is unavailable.", true);
      const constructors = targetWindow as unknown as {
        HTMLInputElement: typeof HTMLInputElement;
        Event: typeof Event;
      };
      const nativeValueSetter = Object.getOwnPropertyDescriptor(constructors.HTMLInputElement.prototype, "value")?.set;
      if (!nativeValueSetter) throw new AutomationError("control_not_editable", "hard_failure", `${target.description} cannot accept values.`);
      input.focus();
      nativeValueSetter.call(input, value);
      input.dispatchEvent(new constructors.Event("input", { bubbles: true }));
      input.dispatchEvent(new constructors.Event("change", { bubbles: true }));
      await pause(50);
      return found.locator;
    },
    async click(target) {
      const found = requireTarget(getDocument(frame), target);
      (found.element as HTMLElement).click();
      return found.locator;
    },
    async waitForOutcome(outcomes: OutcomeDefinition[], timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const document = getDocument(frame);
        for (const outcome of outcomes) {
          if (findTarget(document, outcome.target)) return outcome;
        }
        await pause(100);
      }
      throw new AutomationError("outcome_timeout", "recoverable", "No declared outcome appeared before the step timeout.", true);
    },
    async extract(target) {
      return requireTarget(getDocument(frame), target).element.textContent?.trim() ?? "";
    },
    async verify(target) {
      return Boolean(findTarget(getDocument(frame), target));
    },
  };
}

function toLogEntry(event: EvidenceEvent): LogEntry {
  return {
    time: formatTime(event.at),
    step: event.stepId,
    detail: event.detail,
    state: event.outcome === "error" ? "error" : event.outcome === "business_outcome" ? "warn" : "ok",
  };
}

export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const runCounterRef = useRef(0);
  const [memberId, setMemberId] = useState("12345");
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<ReplayResult | null>(null);

  async function runReplay(event: FormEvent) {
    event.preventDefault();
    if (runStatus === "running") return;
    const frame = frameRef.current;
    if (!frame) return;
    setRunStatus("running");
    setLogs([]);
    setResult(null);

    const replay = await executeCapability({
      artifact: rawCapability,
      inputs: { memberId },
      origin: window.location.origin,
      adapter: createIframeAdapter(frame, () => ++runCounterRef.current),
      onEvidence: (evidence) => setLogs((items) => [...items, toLogEntry(evidence)]),
    });
    setResult(replay);
    setRunStatus(replay.status);
  }

  return (
    <main className="console-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">NC</span><div><p className="eyebrow">Northstar Automation Lab</p><h1>Capability Replay Console</h1></div></div>
        <div className="environment-badge"><span /> Local sandbox</div>
      </header>

      <section className="overview-grid">
        <div><p className="section-kicker">Foundation milestone</p><h2>Get a member’s savings balance—without model decisions.</h2><p className="lede">A policy-checked executor interprets a typed, versioned capability against the legacy portal in the live session below.</p></div>
        <dl className="capability-facts"><div><dt>Capability</dt><dd>{capability.name}</dd></div><div><dt>Version</dt><dd>{capability.version}</dd></div><div><dt>Steps</dt><dd>{capability.steps.length}</dd></div><div><dt>Risk</dt><dd>{capability.policy.risk.replace("_", " ")}</dd></div></dl>
      </section>

      <section className="workspace-grid">
        <div className="panel target-panel">
          <div className="panel-heading"><div><span className="panel-number">01</span><h3>Live target session</h3></div><a href="/legacy" target="_blank" rel="noreferrer">Open manually ↗</a></div>
          <div className="browser-frame"><div className="browser-bar"><span /><span /><span /><div className="address-bar">same origin / legacy / member-services</div></div><iframe ref={frameRef} title="Legacy credit union member portal" src="/legacy?embedded=1" /></div>
        </div>

        <aside className="panel run-panel">
          <div className="panel-heading"><div><span className="panel-number">02</span><h3>Deterministic replay</h3></div><span className={`status-pill ${runStatus}`}>{runStatus.replace("_", " ")}</span></div>
          <form onSubmit={runReplay} className="run-form">
            <label htmlFor="member-id">Member ID input</label>
            <div className="input-row"><input id="member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" aria-describedby="member-hint" /><button type="submit" disabled={runStatus === "running" || memberId.length !== 5}>{runStatus === "running" ? "Running…" : "Run capability"}</button></div>
            <p id="member-hint">Try <button type="button" className="inline-button" onClick={() => setMemberId("12345")}>12345</button> for success or <button type="button" className="inline-button" onClick={() => setMemberId("00000")}>00000</button> for not found.</p>
          </form>

          <div className="result-card" aria-live="polite">
            <p className="result-label">Structured result</p>
            {!result && <p className="empty-result">Run the capability to produce a typed result.</p>}
            {result?.status === "success" && <div className="success-result"><strong>{result.outputs.balance}</strong><span>Savings balance · {result.outputs.accountStatus}</span></div>}
            {result?.status === "business_outcome" && <div className="outcome-result"><strong>{result.code}</strong><span>{result.message}</span></div>}
            {result?.status === "failure" && <div className="failure-result"><strong>{result.error.code}</strong><span>{result.error.category} · step {result.error.stepId} · {result.error.message}</span></div>}
          </div>

          <div className="log-header"><span>Evidence log</span><span>{logs.length} events</span></div>
          <ol className="event-log">
            {logs.length === 0 && <li className="log-empty">No run evidence yet.</li>}
            {logs.map((log, index) => <li key={`${log.time}-${index}`} className={log.state}><span className="log-marker" /><div><strong>{log.step}</strong><p>{log.detail}</p></div><time>{log.time}</time></li>)}
          </ol>
        </aside>
      </section>
    </main>
  );
}
