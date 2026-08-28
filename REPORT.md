# Computer-Use Automation System — Design Report

## Architecture

The system is split into three seams: a versioned capability contract, a policy-checked executor, and a surface adapter. The current web adapter operates the local legacy portal through its live iframe session. The executor knows actions, inputs, outcomes, checkpoints, and evidence, but not React or DOM mechanics. This keeps deterministic replay testable and leaves a clean provider boundary for the next discovery phase.

The target is intentionally local and synthetic. It exercises lookup, asynchronous loading, extraction, and a legitimate not-found outcome without touching a real institution or persisting financial data.

## Artifact schema

Each artifact declares identity and semantic version, target application and surface, typed inputs and outputs, risk policy, ordered steps, robust locator candidates, recognized business outcomes, and a final checkpoint. Inputs can be marked sensitive so evidence names the parameter but never records its value. At least two locators are required for every control target to make fallback intent reviewable.

The artifact stores reusable execution intent rather than a raw model transcript. Discovery will compile into this contract; production replay consumes it without model decisions.

## Determinism & error handling

Replay validates the artifact and invocation before touching the target. It checks the path allowlist before session start and after every step, enforces action and step limits, applies step and run timeouts, extracts every declared output, and verifies the final checkpoint.

Results separate success, known business outcomes, and failures. Failures include category, code, step, message, and retryability. The current adapter uses ordered locator fallbacks. Missing locators, outputs, or checkpoints are hard failures; timeouts are recoverable; unsafe navigation and disallowed actions are policy denials.

## Heterogeneity & multi-tenant

The `SurfaceAdapter` boundary is the extension seam. A legacy-web adapter can replace DOM queries with accessibility-tree or visual matching, and a desktop adapter can map the same action/target contract to OS-level controls. Future locator variants should carry surface-specific strategies without changing the executor result contract.

For multi-tenant reuse, the capability should be owned by vendor product and version, with institution-specific target configuration and small locator overrides. Replay evidence can track locator success rates and checkpoint failures to detect drift before specializing or re-recording an artifact.

## Escalation & handoff

Human takeover is the next major capability after discovery. The executor already preserves a live adapter session and returns an exact failure step with evidence. The next control model will add `automation`, `human_requested`, `human`, and `resuming` ownership states around the same session, record manual actions, and require an explicit resume signal.

## Safety

The current capability is read-only. Runtime checks enforce same-origin route prefixes, action allowlists, maximum steps, total timeout, and input shape. Sensitive parameter values are redacted from evidence. Irreversible capabilities are rejected unless their policy requires human approval.

This is not yet a complete production security boundary: hosted authentication, encrypted evidence storage, secret injection, operator authorization, and tamper-resistant artifact approval are deliberately outside this milestone.

## Cuts

This phase finishes the deterministic foundation. It does not yet include live LLM discovery, automatic artifact compilation, persisted evidence files, failure screenshots, injected session/permission errors, or human takeover. The next phase is goal-driven discovery and artifact generation; after that, add persistent evidence and same-session human handoff before broader polish or stretch goals.
