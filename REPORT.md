# Computer-Use Automation System — Design Report

## Architecture

The system now has four seams: a goal-driven discovery engine, a provider boundary, a versioned capability contract, and a deterministic executor. Discovery runs a constrained observe–decide–act loop against the live iframe, validates every proposed action, and compiles only a verified trace. Production replay consumes the compiled artifact without calling a model.

The server provider uses the OpenAI Responses API with strict structured output and `store: false`. If no API key is configured, the client labels and uses a policy-equivalent simulator; other provider failures remain visible instead of silently becoming simulated success. The target and member data are local and synthetic.

## Artifact schema

Artifacts declare identity and semantic version, target surface, typed inputs and outputs, risk policy, ordered actions, two locator candidates per target, recognized business outcomes, and a final checkpoint. Discovery metadata records the provider and generation time, but the model transcript is discarded. Sensitive invocation values never enter the artifact or provider prompt.

Compilation accepts only the complete five-action savings lookup trace. This prevents a plausible but incomplete model response from becoming executable automation.

## Determinism & error handling

Discovery and replay validate their contracts before acting. Both enforce the same-origin `/legacy` allowlist, action and step limits, timeouts, output requirements, known business outcomes, and checkpoint verification. Provider decisions are rejected when they reference hidden or unknown controls, undeclared inputs or outputs, or arbitrary selectors.

Results distinguish success, business outcome, recoverable failure, policy denial, and hard failure. Replay uses ordered locator fallbacks and records the locator that succeeded. `member_not_found` exits as a valid business outcome rather than a system error.

## Heterogeneity & multi-tenant

`DiscoveryAdapter` and `SurfaceAdapter` isolate surface mechanics from planning and execution. A desktop or accessibility-tree adapter can implement the same contracts without changing artifacts or result handling. Tenant reuse should key capabilities by vendor product and version, with institution-specific configuration and small reviewed locator overrides.

## Escalation & handoff

The next phase adds `automation`, `human_requested`, `human`, and `resuming` ownership states around the existing live session. Evidence already identifies the exact failing phase or replay step, which provides a clean handoff point. Resume must be explicit and must revalidate the current target and checkpoint.

## Safety

The capability is read-only. Runtime policy enforces target path, action allowlist, step budget, total timeout, input shape, declared extraction fields, and final checkpoint. Sensitive values stay in the browser adapter and are replaced with placeholders before provider calls and evidence recording. Provider responses cannot supply selectors directly.

This remains a demonstration boundary: hosted authentication, encrypted persistent evidence, operator authorization, secret injection, and tamper-resistant artifact approval belong in the next production-hardening phase.

## Cuts

Phase 2 completes goal-driven discovery, structured provider integration, automatic compilation, artifact inspection/download, and immediate deterministic replay. Redacted example evidence is checked in, while durable run storage, screenshots, session/permission fault injection, and human takeover are deferred. Live model execution requires a configured server-side API key; the safe simulator keeps the project runnable without one.
