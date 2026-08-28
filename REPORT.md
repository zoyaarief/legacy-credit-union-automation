# Computer-Use Automation System — Design Report

## Architecture

The system has seven seams: a goal-driven discovery engine, a provider boundary, a versioned capability contract, an exact-artifact approval registry, a pausable deterministic executor, a control-transfer state machine, and per-user durable run storage. Discovery compiles only a verified trace. Generated or restored artifacts enter `draft` and cannot replay until the signed-in reviewer approves their SHA-256 fingerprint. The bundled reviewed baseline remains executable. D1 stores sanitized approvals, artifacts, outcomes, surface snapshots, and evidence behind the authenticated Sites user id.

The server provider uses the OpenAI Responses API with strict structured output and `store: false`. If no API key is configured, the client labels and uses a policy-equivalent simulator; other provider failures remain visible instead of silently becoming simulated success. The target and member data are local and synthetic.

## Artifact schema

Artifacts declare identity and semantic version, target surface, typed inputs and outputs, risk policy, ordered actions, two locator candidates per target, recognized business outcomes, and a final checkpoint. Discovery metadata records the provider and generation time, but the model transcript is discarded. Sensitive invocation values never enter the artifact or provider prompt.

Compilation accepts only the complete five-action savings lookup trace. This prevents a plausible but incomplete model response from becoming executable automation. Approval binds to canonical sanitized artifact content, so any content change produces a different fingerprint and returns to review.

## Determinism & error handling

Discovery and replay validate their contracts before acting. Both enforce the same-origin `/legacy` allowlist, action and step limits, timeouts, output requirements, known business outcomes, and checkpoint verification. Provider decisions are rejected when they reference hidden or unknown controls, undeclared inputs or outputs, or arbitrary selectors.

Results distinguish success, business outcome, human-required intervention, recoverable failure, policy denial, and hard failure. Replay uses ordered locator fallbacks and records the locator that succeeded. `member_not_found` exits as a valid business outcome. An operator-only interstitial returns a resume cursor rather than becoming a crash or being bypassed. Fault injection now proves that session expiry and slow-load timeout are retryable recoverable failures, while an application error is a non-retryable hard failure.

## Heterogeneity & multi-tenant

`DiscoveryAdapter` and `SurfaceAdapter` isolate surface mechanics from planning and execution. A desktop or accessibility-tree adapter can implement the same contracts without changing artifacts or result handling. Tenant reuse should key capabilities by vendor product and version, with institution-specific configuration and small reviewed locator overrides.

## Escalation & handoff

The implemented ownership states are `automation`, `human_requested`, `human`, `resuming`, and `completed`. A restricted-account interstitial raises an intervention containing the capability, exact stopped step, reason, and a redacted structured surface snapshot. The executor pauses before the blocked action and preserves its cursor and iframe.

After an operator accepts, the existing iframe becomes the manual control surface. Click and input events are captured by control name only; values are never recorded. Resume is explicit, skips session preparation, revalidates the current URL, continues from the stopped wait step, and verifies the original outputs and checkpoint. The complete evidence sequence is stored under the same run id.

## Safety

The capability is read-only. Runtime policy enforces target path, action allowlist, step budget, total timeout, input shape, declared extraction fields, and final checkpoint. Sensitive values stay in the browser adapter and are replaced with placeholders before provider calls and evidence recording. Provider responses cannot supply selectors directly.

The private Site supplies the stable authenticated user id used for record ownership. Local development receives an isolated demo owner only on localhost. Stored evidence is sanitized, SHA-256 fingerprinted, and assigned a reviewer-selected 7, 30, or 90-day expiry; expired rows are pruned on access, and deletion always includes the authenticated owner id. This adds integrity and minimization controls, but does not claim application-layer encryption or enterprise key management.

## Cuts

Phase 4 completes approval-gated artifacts, evidence integrity, retention/deletion, and the first explicit recovery matrix. The richer failure signal remains a redacted structured surface snapshot rather than a screenshot to avoid capturing regulated values. Separate reviewer/operator identities, multi-party approvals, managed-key application encryption, broader network/permission faults, and cross-device continuation are deliberately deferred to Phase 5. Live model execution still requires a configured server-side API key; the safe simulator keeps the core runnable without one.
