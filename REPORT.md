# Computer-Use Automation System — Design Report

## Architecture

The system has four control planes around the deterministic executor: discovery and compilation, artifact review and catalog invocation, live execution and handoff, and durable security operations. Discovery compiles only a verified trace. Generated or restored artifacts enter `draft` and cannot replay until the signed-in reviewer approves their SHA-256 fingerprint. The bundled reviewed baseline and its reviewed tenant variants remain executable. D1 stores sanitized approvals, artifacts, rate windows, operational events, outcomes, surface snapshots, and encrypted evidence behind the authenticated Sites user id.

The server provider uses the OpenAI Responses API with strict structured output and `store: false`. If no API key is configured, the client labels and uses a policy-equivalent simulator; other provider failures remain visible instead of silently becoming simulated success. The target and member data are local and synthetic.

## Artifact schema

Artifacts declare identity and semantic version, target surface, typed inputs and outputs, risk policy, ordered actions, two locator candidates per target, recognized business outcomes, and a final checkpoint. Discovery metadata records the provider and generation time, but the model transcript is discarded. Sensitive invocation values never enter the artifact or provider prompt.

Compilation accepts only the complete five-action savings lookup trace. This prevents a plausible but incomplete model response from becoming executable automation. Approval binds to canonical sanitized artifact content, so any content change produces a different fingerprint and returns to review.

## Determinism & error handling

Discovery and replay validate their contracts before acting. Both enforce the same-origin `/legacy` allowlist, action and step limits, timeouts, output requirements, known business outcomes, and checkpoint verification. Provider decisions are rejected when they reference hidden or unknown controls, undeclared inputs or outputs, or arbitrary selectors.

Results distinguish success, business outcome, human-required intervention, recoverable failure, policy denial, and hard failure. Replay uses ordered locator fallbacks and records the locator that succeeded. `member_not_found` exits as a valid business outcome. An operator-only interstitial returns a resume cursor rather than becoming a crash or being bypassed. A separate policy wrapper may restart the allowlisted session exactly once for explicitly allowlisted retryable codes. It merges both attempts and the recovery decision into one ordered evidence stream. Session expiry and slow-load timeout recover on a clean deterministic retry; application errors remain non-retryable hard failures.

## Heterogeneity & multi-tenant

`DiscoveryAdapter` and `SurfaceAdapter` isolate surface mechanics from planning and execution. A desktop or accessibility-tree adapter can implement the same contracts without changing artifacts or result handling. The catalog keys the capability to `northstar-core-member-services@8` and resolves only static reviewed tenant profiles. The east-branch profile changes the entry point and two ordered locators while preserving inputs, outputs, policy, business outcomes, and checkpoint semantics.

### Agent catalog & stability

Authenticated agents can list the typed capability contract and request an invocation ticket by exact capability name, version, tenant variant, and typed inputs. The server resolves only reviewed variants and fingerprints the resulting artifact. Ticket issue is limited atomically in D1 to 12 requests per authenticated owner per minute. Every ticket is bound to the owner, exact capability, variant, typed inputs, artifact fingerprint, issue time, and 120-second expiry with HMAC-SHA-256. The browser submits it back to the server for signature, lifetime, input, variant, and fingerprint verification, and executes only the canonical artifact returned by that verification; the catalog does not introduce a second execution engine.

The console can execute three live canaries against the selected variant. All clean successes classify as stable, any recovery or a two-of-three result requires review, and fewer than two successes is unstable. Every canary remains an encrypted, owner-scoped `agent_invocation` run in the audit trail.

## Escalation & handoff

The implemented ownership states are `automation`, `human_requested`, `human`, `resuming`, and `completed`. A restricted-account interstitial raises an intervention containing the capability, exact stopped step, reason, and a redacted structured surface snapshot. The executor pauses before the blocked action and preserves its cursor and iframe.

After an operator accepts, the existing iframe becomes the manual control surface. Click and input events are captured by control name only; values are never recorded. Resume is explicit, skips session preparation, revalidates the current URL, continues from the stopped wait step, and verifies the original outputs and checkpoint. The complete evidence sequence is stored under the same run id.

## Safety

The capability is read-only. Runtime policy enforces target path, action allowlist, step budget, total timeout, input shape, declared extraction fields, and final checkpoint. Discovery inputs stay in the browser adapter and are replaced with placeholders before provider calls and evidence recording. Agent invocation inputs cross only the authenticated issue/verify boundary, are signature-bound, and never enter telemetry or run evidence. Provider responses cannot supply selectors directly.

The private Site supplies the stable authenticated user id used for record ownership. Local development receives an isolated demo owner only on localhost. Stored evidence is sanitized, SHA-256 fingerprinted, AES-256-GCM encrypted with a managed runtime secret, and assigned a reviewer-selected 7, 30, or 90-day expiry. AES-GCM additional authenticated data binds ciphertext to owner, run id, and evidence hash, preventing row swapping. Expired rows are pruned on access, and deletion always includes the authenticated owner id. Key versions are stored beside ciphertext so rotation can use a controlled decrypt-and-reencrypt migration.

The runtime accepts a current and previous evidence key. Reads resolve the secret by stored key version, while the rotation endpoint re-encrypts at most 50 owner-scoped rows per request under the current version and preserves the authenticated context. The previous key is removable only after telemetry reports zero stale rows.

### Operations

Operational events contain no invocation values. Ticket issue, verification, rejection, limiting, agent-run storage, and evidence rotation are owner-scoped in D1. The console summarizes the last 24 hours, including success and recovery rates, and exposes current key-version posture. Telemetry failures never change the automation contract result.

### Governed operations & alert delivery

Authorization is resolved on the server from the authenticated Site principal. Administrators can assign reviewer, operator, agent, and viewer roles in D1. Artifact approval requires reviewer authority, while durable job claiming and completion require operator authority. The configured owner id is bootstrapped as administrator so existing single-owner operation remains available.

A protected control tick requeues expired job leases, deduplicates waiting-intervention alerts into a durable outbox, and drains due entries in bounded batches. Webhook requests sign the exact JSON body with HMAC-SHA-256. Delivery failures retain the alert and apply exponential backoff up to one hour. External delivery remains dormant when a destination is not configured.

Approval is capability-fingerprint scoped rather than browser-state scoped. Read-only artifacts need one reviewer so the focused demo stays operable. Artifacts marked irreversible or requiring human approval need two distinct reviewer decisions, and the submitting principal cannot vote. Approval and rejection decisions are durable, replaceable by the same reviewer, and recompute the request state; any rejection blocks unattended replay. This adds real separation of duties without pretending the current owner-only Site already has multiple people.

### Durable jobs & cross-device recovery

Jobs persist encrypted typed inputs, canonical artifact identity, status, lease, and redacted result metadata in D1. A browser worker claims a job for three minutes, receives a fresh signed ticket, verifies it through the existing catalog boundary, and uses the same deterministic executor. Expired leases are reclaimable.

`human_required` is a durable job status. Another signed-in device can claim it, decrypt its inputs server-side, and deterministically rehydrate the target to the intervention checkpoint before handing control to the operator. The browser session itself is not transferred across devices; the safe read-only path is replayed and revalidated.

Operational alerts are derived from stored state rather than client counters: low success rate, elevated ticket rejection, queue backlog, waiting intervention, and pending key rotation. Waiting-intervention alerts enter the signed external-delivery outbox; other alerts remain visible in-product.

## Cuts

Phase 10 completes a durable reviewer queue, risk-derived quorum, and submitter/reviewer separation for risky artifacts. The private demo still has one granted Site owner, so a real two-person vote cannot be demonstrated until another authenticated Site visitor is granted. No external webhook or platform scheduler destination was provided, so those integrations remain configuration-gated. Fully unattended browser execution and broader network faults remain deliberate cuts.
