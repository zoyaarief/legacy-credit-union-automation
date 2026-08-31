"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import rawCapability from "@/capabilities/get-savings-balance.v1.json";
import {
  executeCapability,
  executeCapabilityWithRecovery,
  validateCapability,
  type Capability,
  type EvidenceEvent,
  type ReplayResult,
  type ReplayResume,
} from "@/lib/automation/core";
import {
  runDiscovery,
  type DiscoveryEvidenceEvent,
  type DiscoveryResult,
  type DiscoveryResume,
} from "@/lib/discovery/core";
import { createAdaptiveDiscoveryProvider } from "@/lib/discovery/provider-client";
import { INITIAL_HANDOFF_STATE, terminalResumeEvent, transitionHandoff, type HandoffState } from "@/lib/handoff/core";
import {
  captureHumanActions,
  createDiscoveryAdapter,
  createReplayAdapter,
  type FaultMode,
} from "@/lib/browser/live-surface";

const savedCapability = validateCapability(rawCapability);

type Mode = "discover" | "replay" | "handoff";
type RunStatus = "idle" | "running" | ReplayResult["status"];
type DiscoveryStatus = "idle" | "running" | DiscoveryResult["status"];
type LogEntry = { time: string; step: string; detail: string; state: "ok" | "warn" | "error"; provider?: string };

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function toReplayLog(event: EvidenceEvent): LogEntry {
  return {
    time: formatTime(event.at),
    step: event.stepId,
    detail: event.detail,
    state: event.outcome === "error" ? "error" : ["business_outcome", "intervention"].includes(event.outcome) ? "warn" : "ok",
  };
}

function toDiscoveryLog(event: DiscoveryEvidenceEvent): LogEntry {
  return {
    time: formatTime(event.at),
    step: `${String(event.step).padStart(2, "0")} · ${event.phase}`,
    detail: event.detail,
    state: event.outcome === "error" ? "error" : ["business_outcome", "intervention"].includes(event.outcome) ? "warn" : "ok",
    provider: event.provider,
  };
}

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const runCounterRef = useRef(0);
  const replayResumeRef = useRef<ReplayResume | null>(null);
  const discoveryResumeRef = useRef<DiscoveryResume | null>(null);
  const stopHumanCaptureRef = useRef<(() => void) | null>(null);
  const [mode, setMode] = useState<Mode>("discover");
  const [goal, setGoal] = useState("Look up member {{memberId}} and return the current savings balance and account status.");
  const [target, setTarget] = useState("/legacy");
  const [memberId, setMemberId] = useState("12345");
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>("idle");
  const [discoveryLogs, setDiscoveryLogs] = useState<LogEntry[]>([]);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [generatedArtifact, setGeneratedArtifact] = useState<Capability | null>(null);
  const [replayArtifact, setReplayArtifact] = useState<Capability>(savedCapability);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [replayLogs, setReplayLogs] = useState<LogEntry[]>([]);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [handoff, setHandoff] = useState<HandoffState>(INITIAL_HANDOFF_STATE);
  const [faultMode, setFaultMode] = useState<FaultMode>("none");
  const [recoveryStatus, setRecoveryStatus] = useState<{ attempts: number; recovered: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  const busy = !ready || discoveryStatus === "running" || runStatus === "running" || handoff.owner === "resuming";
  const discoveryInvocationLocked = mode === "discover" && ["human_requested", "human", "resuming"].includes(handoff.owner);

  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => {
      window.clearTimeout(timer);
      stopHumanCaptureRef.current?.();
    };
  }, []);

  function changeMode(nextMode: Mode) {
    stopHumanCaptureRef.current?.();
    stopHumanCaptureRef.current = null;
    setMode(nextMode);
    if (nextMode === "handoff") {
      replayResumeRef.current = null;
      setHandoff(INITIAL_HANDOFF_STATE);
      setReplayResult(null);
      setReplayLogs([]);
      setRunStatus("idle");
    }
  }

  async function discover(event: FormEvent) {
    event.preventDefault();
    const frame = frameRef.current;
    if (!frame || busy) return;
    stopHumanCaptureRef.current?.();
    stopHumanCaptureRef.current = null;
    discoveryResumeRef.current = null;
    setHandoff(INITIAL_HANDOFF_STATE);
    setDiscoveryStatus("running");
    setDiscoveryLogs([]);
    setDiscoveryResult(null);
    setGeneratedArtifact(null);
    const result = await runDiscovery({
      goal,
      target,
      inputs: { memberId },
      origin: window.location.origin,
      provider: createAdaptiveDiscoveryProvider(),
      adapter: createDiscoveryAdapter(frame, () => ++runCounterRef.current),
      onEvidence: (evidence) => setDiscoveryLogs((items) => [...items, toDiscoveryLog(evidence)]),
    });
    if (result.status === "success") setGeneratedArtifact(result.artifact);
    if (result.status === "human_required") {
      discoveryResumeRef.current = result.resume;
      setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId }));
    }
    setDiscoveryResult(result);
    setDiscoveryStatus(result.status);
  }

  async function resumeDiscovery() {
    const frame = frameRef.current;
    const resume = discoveryResumeRef.current;
    if (!frame || !resume || handoff.owner !== "human") return;
    stopHumanCaptureRef.current?.();
    stopHumanCaptureRef.current = null;
    setHandoff((state) => transitionHandoff(state, { type: "resume" }));
    setDiscoveryStatus("running");
    const result = await runDiscovery({
      goal,
      target,
      inputs: { memberId },
      origin: window.location.origin,
      provider: createAdaptiveDiscoveryProvider(),
      adapter: createDiscoveryAdapter(frame, () => ++runCounterRef.current),
      resume,
      humanActions: handoff.actions,
      onEvidence: (evidence) => setDiscoveryLogs((items) => [...items, toDiscoveryLog(evidence)]),
    });
    setDiscoveryLogs(result.evidence.map(toDiscoveryLog));
    setDiscoveryResult(result);
    setDiscoveryStatus(result.status);
    if (result.status === "success") {
      discoveryResumeRef.current = null;
      setGeneratedArtifact(result.artifact);
      setHandoff((state) => transitionHandoff(state, { type: "complete" }));
    } else if (result.status === "human_required") {
      discoveryResumeRef.current = result.resume;
      setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId }));
    } else {
      discoveryResumeRef.current = null;
      setHandoff((state) => transitionHandoff(state, terminalResumeEvent(result.status)));
    }
  }

  async function replay(event: FormEvent) {
    event.preventDefault();
    const frame = frameRef.current;
    if (!frame || busy) return;
    setRunStatus("running");
    setReplayLogs([]);
    setReplayResult(null);
    setRecoveryStatus(null);
    const execution = await executeCapabilityWithRecovery({
      artifact: replayArtifact,
      inputs: { memberId },
      origin: window.location.origin,
      createAdapter: (attempt) => createReplayAdapter(frame, () => ++runCounterRef.current, attempt === 1 ? faultMode : "none"),
      maxAttempts: 2,
      onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]),
    });
    setRecoveryStatus({ attempts: execution.attempts, recovered: execution.recovered });
    setReplayResult(execution.result);
    setRunStatus(execution.result.status);
  }

  async function startHandoff() {
    const frame = frameRef.current;
    if (!frame || busy) return;
    stopHumanCaptureRef.current?.();
    replayResumeRef.current = null;
    setMemberId("31415");
    setHandoff(INITIAL_HANDOFF_STATE);
    setRunStatus("running");
    setReplayLogs([]);
    setReplayResult(null);
    const result = await executeCapability({
      artifact: replayArtifact,
      inputs: { memberId: "31415" },
      origin: window.location.origin,
      adapter: createReplayAdapter(frame, () => ++runCounterRef.current),
      onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]),
    });
    setReplayResult(result);
    setRunStatus(result.status);
    if (result.status === "human_required") {
      replayResumeRef.current = result.resume;
      setHandoff(transitionHandoff(INITIAL_HANDOFF_STATE, { type: "request", interventionId: result.runId }));
    }
  }

  function acceptHumanControl() {
    const frame = frameRef.current;
    if (!frame) return;
    setHandoff((state) => transitionHandoff(state, { type: "accept" }));
    stopHumanCaptureRef.current = captureHumanActions(frame, (action) => {
      setHandoff((state) => transitionHandoff(state, { type: "record", action }));
    });
  }

  async function resumeAutomation() {
    const frame = frameRef.current;
    const resume = replayResumeRef.current;
    if (!frame || !resume || handoff.owner !== "human") return;
    stopHumanCaptureRef.current?.();
    stopHumanCaptureRef.current = null;
    setHandoff((state) => transitionHandoff(state, { type: "resume" }));
    setRunStatus("running");
    const result = await executeCapability({
      artifact: replayArtifact,
      inputs: { memberId: "31415" },
      origin: window.location.origin,
      adapter: createReplayAdapter(frame, () => ++runCounterRef.current),
      resume,
      humanActions: handoff.actions,
      onEvidence: (evidence) => setReplayLogs((items) => [...items, toReplayLog(evidence)]),
    });
    setReplayLogs(result.evidence.map(toReplayLog));
    setReplayResult(result);
    setRunStatus(result.status);
    if (result.status === "success" || result.status === "business_outcome") {
      setHandoff((state) => transitionHandoff(state, terminalResumeEvent(result.status)));
    } else if (result.status === "human_required") {
      replayResumeRef.current = result.resume;
      setHandoff((state) => transitionHandoff(state, { type: "request", interventionId: result.runId }));
    } else {
      replayResumeRef.current = null;
      setHandoff((state) => transitionHandoff(state, terminalResumeEvent(result.status)));
    }
  }

  function useGeneratedArtifact() {
    if (!generatedArtifact) return;
    setReplayArtifact(generatedArtifact);
    setMode("replay");
    setRunStatus("idle");
    setReplayResult(null);
    setReplayLogs([]);
    setRecoveryStatus(null);
  }

  const activeLogs = mode === "discover" ? discoveryLogs : replayLogs;
  const activeStatus = mode === "discover"
    ? discoveryStatus
    : mode === "handoff" && handoff.owner !== "automation"
      ? handoff.owner
      : runStatus;

  return <main className="console-shell" data-ready={ready}>
    <header className="topbar">
      <div className="brand-lockup"><span className="brand-mark">NC</span><div><p className="eyebrow">Northstar Automation Lab</p><h1>Computer-Use Control Plane</h1></div></div>
      <div className="environment-badge"><span /> Focused demo</div>
    </header>

    <section className="overview-grid phase-two-overview">
      <div><p className="section-kicker">Core vertical slice</p><h2>Discover once. Replay deterministically. Hand off safely.</h2><p className="lede">A model explores the live legacy surface and compiles a typed capability. Replay executes that reviewed contract without model decisions and pauses in the same session when a human is required.</p></div>
      <dl className="capability-facts"><div><dt>Discovery</dt><dd>Observe → decide → act</dd></div><div><dt>Artifact</dt><dd>Typed + versioned</dd></div><div><dt>Replay</dt><dd>LLM-free + bounded</dd></div><div><dt>Handoff</dt><dd>Same live session</dd></div></dl>
    </section>

    <nav className="mode-switch" aria-label="Automation mode">
      <button className={mode === "discover" ? "active" : ""} onClick={() => changeMode("discover")} disabled={busy}><span>01</span> Discover</button>
      <button className={mode === "replay" ? "active" : ""} onClick={() => changeMode("replay")} disabled={busy}><span>02</span> Replay</button>
      <button className={mode === "handoff" ? "active" : ""} onClick={() => changeMode("handoff")} disabled={busy}><span>03</span> Human handoff</button>
    </nav>

    <section className="workspace-grid">
      <div className="panel target-panel">
        <div className="panel-heading"><div><span className="panel-number">LIVE</span><h3>Target session</h3></div><a href="/legacy" target="_blank" rel="noreferrer">Open manually ↗</a></div>
        <div className={`ownership-strip ${handoff.owner}`}><span>Control</span><strong>{mode === "handoff" || (mode === "discover" && handoff.owner !== "automation") ? handoff.owner.replace("_", " ") : "automation"}</strong><small>Same session retained</small></div>
        <div className="browser-frame"><div className="browser-bar"><span /><span /><span /><div className="address-bar">allowlisted / legacy / member-services</div></div><iframe ref={frameRef} title="Legacy credit union member portal" src="/legacy?embedded=1" /></div>
      </div>

      <aside className="panel run-panel">
        <div className="panel-heading"><div><span className="panel-number">{mode === "discover" ? "AI" : mode === "replay" ? "DET" : "HITL"}</span><h3>{mode === "discover" ? "Goal-driven discovery" : mode === "replay" ? "Deterministic replay" : "Intervention control"}</h3></div><span className={`status-pill ${activeStatus}`}>{String(activeStatus).replace("_", " ")}</span></div>

        {mode === "discover" && <>
          <form onSubmit={discover} className="run-form discovery-form">
            <label htmlFor="goal">Goal</label>
            <textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value.slice(0, 500))} required minLength={12} maxLength={500} disabled={discoveryInvocationLocked} />
            <p>Supported intent: read-only member savings balance and account-status lookup.</p>
            <label htmlFor="discovery-target">Target entry point</label>
            <input id="discovery-target" value={target} onChange={(event) => setTarget(event.target.value.slice(0, 240))} required disabled={discoveryInvocationLocked} />
            <label htmlFor="discovery-member-id">Invocation input</label>
            <div className="input-row"><input id="discovery-member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" disabled={discoveryInvocationLocked} /><button type="submit" disabled={busy || discoveryInvocationLocked || memberId.length !== 5}>{discoveryStatus === "running" ? "Discovering…" : "Discover capability"}</button></div>
            <p>Use <button type="button" className="inline-button" onClick={() => setMemberId("12345")} disabled={discoveryInvocationLocked}>12345</button> for success or <button type="button" className="inline-button" onClick={() => setMemberId("31415")} disabled={discoveryInvocationLocked}>31415</button> to verify discovery handoff. Sensitive values stay local.</p>
          </form>
          <div className="result-card discovery-result" aria-live="polite"><p className="result-label">Discovery result</p>
            {!discoveryResult && <p className="empty-result">Submit a goal to start the constrained loop.</p>}
            {discoveryResult?.status === "success" && <div className="success-result"><strong>{discoveryResult.artifact.name}</strong><span>{discoveryResult.artifact.steps.length} actions · {discoveryResult.provider} · {discoveryResult.outputs.balance} · {discoveryResult.outputs.accountStatus}</span><div className="result-actions"><button onClick={useGeneratedArtifact}>Replay generated artifact</button><button className="secondary" onClick={() => downloadJson(`${discoveryResult.artifact.name}.json`, discoveryResult.artifact)}>Download JSON</button></div></div>}
            {discoveryResult?.status === "human_required" && handoff.owner === "human_requested" && <InterventionCard result={discoveryResult} onAccept={acceptHumanControl} discovery />}
            {discoveryResult?.status === "human_required" && handoff.owner === "human" && <HumanControlCard actionCount={handoff.actions.length} onResume={resumeDiscovery} label="Resume discovery" />}
            {handoff.owner === "resuming" && <div className="handoff-intro"><p className="result-label">Control returned</p><h4>Revalidating discovery…</h4></div>}
            {discoveryResult?.status === "business_outcome" && <div className="outcome-result"><strong>{discoveryResult.code}</strong><span>{discoveryResult.message}</span></div>}
            {discoveryResult?.status === "failure" && <div className="failure-result"><strong>{discoveryResult.error.code}</strong><span>Step {discoveryResult.error.step} · {discoveryResult.error.message}</span></div>}
          </div>
        </>}

        {mode === "replay" && <>
          <div className="artifact-source"><span>Artifact source</span><strong>{replayArtifact === savedCapability ? "Bundled reviewed baseline" : "Generated from live discovery"}</strong><small>{replayArtifact.name}@{replayArtifact.version}</small></div>
          <form onSubmit={replay} className="run-form"><label htmlFor="replay-member-id">Member ID input</label><div className="input-row"><input id="replay-member-id" value={memberId} onChange={(event) => setMemberId(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required pattern="[0-9]{5}" /><button type="submit" disabled={busy || memberId.length !== 5}>{runStatus === "running" ? "Running…" : "Run capability"}</button></div><label htmlFor="fault-mode">Fault injection</label><select id="fault-mode" className="policy-select" value={faultMode} onChange={(event) => setFaultMode(event.target.value as FaultMode)}><option value="none">None — normal execution</option><option value="session_expired">Auto-recover — session expired</option><option value="slow_load">Auto-recover — slow load timeout</option><option value="application_error">Stop — hard application error</option></select><p>Try <button type="button" className="inline-button" onClick={() => setMemberId("12345")}>12345</button> or <button type="button" className="inline-button" onClick={() => setMemberId("00000")}>00000</button>. Recovery is capped at one clean deterministic retry.</p></form>
          <ResultCard result={replayResult} />
          {recoveryStatus && <div className={`recovery-summary ${recoveryStatus.recovered ? "recovered" : "settled"}`}><span>{recoveryStatus.recovered ? "Recovered" : "Policy settled"}</span><strong>{recoveryStatus.attempts} deterministic attempt{recoveryStatus.attempts === 1 ? "" : "s"}</strong><small>{recoveryStatus.recovered ? "The clean retry reached the declared checkpoint." : "No retry was needed or permitted."}</small></div>}
        </>}

        {mode === "handoff" && <div className="handoff-console">
          {handoff.owner === "automation" && <div className="handoff-intro"><p className="result-label">Assisted replay scenario</p><h4>Restricted-account acknowledgment</h4><p>Run the capability until it reaches an operator-only interstitial. The system pauses instead of bypassing it.</p><button onClick={startHandoff} disabled={busy}>Start assisted replay</button></div>}
          {handoff.owner === "human_requested" && replayResult?.status === "human_required" && <InterventionCard result={replayResult} onAccept={acceptHumanControl} />}
          {handoff.owner === "human" && <HumanControlCard actionCount={handoff.actions.length} onResume={resumeAutomation} label="Resume automation" />}
          {handoff.owner === "resuming" && <div className="handoff-intro"><p className="result-label">Control returned</p><h4>Revalidating the live session…</h4></div>}
          {handoff.owner === "failed" && <div className="handoff-complete"><span className="route-badge">Resume failed</span><h4>Automation stopped safely</h4><p>The resumed session did not satisfy the capability contract. Review the structured failure and restart the scenario.</p><button onClick={() => { setHandoff(INITIAL_HANDOFF_STATE); setReplayResult(null); setReplayLogs([]); setRunStatus("idle"); }}>Reset handoff</button><ResultCard result={replayResult} /></div>}
          {handoff.owner === "completed" && <><div className="handoff-complete"><span className="route-badge complete">Handoff complete</span><h4>Automation resumed successfully</h4><p>The same session reached its checkpoint after {handoff.actions.length} recorded human action.</p><button onClick={() => { setHandoff(INITIAL_HANDOFF_STATE); setReplayResult(null); setReplayLogs([]); setRunStatus("idle"); }}>Run again</button></div><ResultCard result={replayResult} /></>}
        </div>}

        <div className="log-header"><span>{mode === "discover" ? "Discovery evidence" : mode === "handoff" ? "Handoff evidence" : "Replay evidence"}</span><span>{activeLogs.length} events</span></div>
        <ol className="event-log phase-two-log">{activeLogs.length === 0 && <li className="log-empty">No evidence yet.</li>}{activeLogs.map((log, index) => <li key={`${log.time}-${index}`} className={log.state}><span className="log-marker" /><div><strong>{log.step}</strong><p>{log.detail}</p>{log.provider && <small>{log.provider}</small>}</div><time>{log.time}</time></li>)}</ol>
      </aside>
    </section>

    {generatedArtifact && <section className="artifact-inspector"><div><p className="section-kicker">Compiled capability</p><h3>{generatedArtifact.name}</h3><p>The live trace compiles into reviewable JSON. The model transcript and sensitive input are not stored.</p><button className="artifact-use" onClick={useGeneratedArtifact}>Use for deterministic replay</button></div><dl><div><dt>Version</dt><dd>{generatedArtifact.version}</dd></div><div><dt>Risk</dt><dd>{generatedArtifact.policy.risk.replace("_", " ")}</dd></div><div><dt>Steps</dt><dd>{generatedArtifact.steps.length}</dd></div><div><dt>Inputs</dt><dd>{Object.keys(generatedArtifact.inputs).join(", ")}</dd></div><div><dt>Outputs</dt><dd>{Object.keys(generatedArtifact.outputs).join(", ")}</dd></div><div><dt>Checkpoint</dt><dd>{generatedArtifact.checkpoint.kind.replace("_", " ")}</dd></div></dl><pre>{JSON.stringify(generatedArtifact, null, 2)}</pre></section>}
  </main>;
}

function InterventionCard({ result, onAccept, discovery = false }: { result: Extract<ReplayResult, { status: "human_required" }> | Extract<DiscoveryResult, { status: "human_required" }>; onAccept: () => void; discovery?: boolean }) {
  const step = discovery && "step" in result.intervention ? `Discovery step ${result.intervention.step}` : "stepId" in result.intervention ? result.intervention.stepId : "Discovery";
  return <div className="intervention-card"><span className="route-badge">Intervention routed</span><h4>{result.intervention.code}</h4><p>{result.intervention.message}</p><dl><div><dt>Stopped at</dt><dd>{step}</dd></div><div><dt>Surface state</dt><dd>{result.intervention.snapshot.visibleSignals.join(", ")}</dd></div></dl><button onClick={onAccept}>{discovery ? "Accept discovery control" : "Accept control"}</button></div>;
}

function HumanControlCard({ actionCount, onResume, label }: { actionCount: number; onResume: () => void; label: string }) {
  return <div className="human-control-card"><span className="route-badge human">Human in control</span><h4>Operate the live session</h4><ol><li>Click <strong>Continue lookup</strong> inside the target session.</li><li>Return here and resume.</li></ol><p>{actionCount} redacted human action{actionCount === 1 ? "" : "s"} captured.</p><button onClick={onResume} disabled={actionCount === 0}>{label}</button></div>;
}

function ResultCard({ result }: { result: ReplayResult | null }) {
  return <div className="result-card" aria-live="polite"><p className="result-label">Structured result</p>{!result && <p className="empty-result">Run the artifact without model decisions.</p>}{result?.status === "success" && <div className="success-result"><strong>{result.outputs.balance}</strong><span>Savings balance · {result.outputs.accountStatus}</span></div>}{result?.status === "business_outcome" && <div className="outcome-result"><strong>{result.code}</strong><span>{result.message}</span></div>}{result?.status === "failure" && <div className="failure-result"><strong>{result.error.code}</strong><span>{result.error.category} · step {result.error.stepId} · {result.error.message}</span></div>}{result?.status === "human_required" && <div className="outcome-result"><strong>human required</strong><span>{result.intervention.message}</span></div>}</div>;
}
