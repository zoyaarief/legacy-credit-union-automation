# Computer-Use Automation System

## Architecture

Northstar combines a synthetic legacy credit-union surface, goal-driven discovery, deterministic replay, and human handoff. A same-origin iframe provides the live surface while keeping target policy explicit.

Discovery is an iterative observe → decide → act loop over a caller-supplied, allowlisted target. On each step, the browser adapter scans only currently visible controls and emits sanitized semantic descriptions, state, locator candidates, output bindings, and human-only classification. A provider chooses one action and references an observation-local control id. The core validates the provider response before execution: the action must be supported, the control must be visible and appropriate for that action, and exactly two selected locators must come from the observed candidate set. The executed trace, not a prewritten workflow map, becomes the source for compilation.

The provider seam supports an OpenAI Responses API route and a deterministic local simulator. The simulator makes the repository runnable without credentials; it does not change the discovery contract. Once discovery compiles a capability, replay uses only the JSON artifact and browser adapter. No model call is made during replay.

## Artifact schema

The artifact is a versioned JSON capability with a deliberately small schema. Identity fields name and version the capability. The target section declares the web application, entry point, and same-origin path-prefix allowlist. Inputs and outputs are typed; the member id input is required, pattern constrained, and marked sensitive. Policy declares the allowed action vocabulary, risk class, step ceiling, run timeout, and whether human approval is required.

Each action has a stable step id. Type, click, and extract actions carry a semantic target plus ordered locator fallbacks. Wait actions declare both the success surface and known business outcomes. The checkpoint independently states the visible condition that must exist before replay can report success. The current capability returns savings balance and account status and declares `member_not_found` as a non-retryable business result.

Discovery compilation uses only the verified live trace. It requires the expected type, click, wait, extract, and completion sequence; each output must come from its own semantically bound control and satisfy its type or allowed-value contract; and the final checkpoint must still be visible. The compiled artifact is passed through the same validator used for the bundled baseline before it reaches the UI.

## Determinism & error handling

Replay validates the complete artifact and invocation inputs before preparing the target. It then executes ordered steps, never asks a model what to do next, and checks the live URL after preparation and after each action. Locator candidates are tried in declared order. Ambiguous, missing, hidden, or disabled targets receive explicit error codes rather than best-effort clicks.

UI drift is handled through redundant semantic locators: stable names or visible button text first, then structural CSS fallbacks observed on the live surface. The executor records the locator that succeeded, making drift visible. If every reviewed locator fails or becomes ambiguous, replay stops with an explicit error instead of guessing; production drift monitoring would quarantine that artifact version for review.

The executor separates invalid requests, policy denials, recoverable failures, hard failures, declared business outcomes, and human-required interruptions. A successful result requires every typed output plus the independent checkpoint. Declared deadlines abort cooperative provider and adapter operations through `AbortSignal`, rather than merely abandoning a still-running promise. A not-found surface returns `business_outcome` rather than masquerading as technical failure; failures retain ordered logs plus a bounded sanitized-DOM snapshot when the surface remains available.

Recovery is bounded. Only an explicit allowlist of retryable codes, such as session expiration and outcome timeout, can start a clean replay, and the demo permits one retry. Application errors, invalid artifacts, policy violations, and checkpoint failures stop immediately. Recovery evidence is appended to the ordered run evidence so the final result explains both attempts.

## Heterogeneity & multi-tenant

The implemented surface is web-only, which is an intentional depth choice. Heterogeneity is handled inside the artifact and observation model rather than through tenant infrastructure.

The boundary for another surface is a reviewed capability artifact and an adapter implementing the same small contract: prepare, identify session, observe/snapshot, type, click, wait, extract, and verify. Desktop or terminal automation would supply a different adapter and target policy, not new replay semantics.

For multi-tenant reuse, a production catalog would key base artifacts by vendor and workflow, with compatibility constraints for product version, surface fingerprint, and semantic controls. Reviewed tenant overlays could change locators, routes, labels, or timing while inheriting business contracts and risk policy. Unknown drift would quarantine unattended execution and require review. This is a design boundary, not claimed implementation.

## Escalation & handoff

The restricted synthetic member `31415` opens an operator acknowledgment dialog. Both discovery and replay recognize that visible state as a human-required interruption. Instead of dismissing or bypassing it, the engine returns a structured intervention containing the reason, stopped step, sanitized surface snapshot, accumulated evidence, and a resume token.

Ownership moves through automation, human requested, human, resuming, and completed states. When the operator accepts control, the application attaches listeners to the existing iframe document. It records only redacted action metadata, never values. After the operator clicks **Continue lookup**, automation resumes at the interrupted step in the same prepared target session. The engine revalidates the target policy, records the human action and control return, continues extraction, and still requires the final checkpoint.

Discovery uses the same handoff pattern. Its resume token preserves the provider history, verified trace, outputs, evidence, and next discovery step. Both discovery and replay place the complete continuation state inside a short-lived HMAC-signed token, including fingerprints of the original goal/input, artifact or target, origin, live-session identity, and stopped step. Client changes to the continuation position, outputs, trace, or evidence fail integrity validation before any adapter operation. Editing is disabled while control is ceded, and a context mismatch also fails closed. A repeated intervention routes control back to a human; a failed resume enters an explicit failed state instead of hanging in `resuming` or being displayed as completed.

## Safety

Safety is enforced in code at several layers. Goal validation uses positive intent classification for the exact supported capability and explicitly rejects mutation, transfers, authentication or credential work, and unrelated account operations before the target is prepared. Provider decisions are constrained to observed controls and observed locators. Both discovery and replay enforce same-origin `/legacy` target policy.

The artifact validator checks schema identity; every input type, required/sensitive flag, and regular expression; outputs; strict risk and approval types; finite positive timeouts; step count; action allowlist; referenced contracts; complete business-outcome definitions; checkpoint structure; and locator redundancy. Unknown or malformed contract values fail closed as `artifact_invalid`. Operator-dialog buttons are rejected by both decision validation and the adapter, so provider compliance is not the safety boundary. Replay redacts sensitive input values from evidence. Discovery sanitizes observed text, and handoff removes member ids, email addresses, and long values from captured action descriptions.

This demo implements only read-only automation. Any artifact marked irreversible or requiring human approval is denied before the browser adapter is prepared. A production approval service could sit outside this boundary, but inventing a custom authorization platform would not improve the assignment’s core computer-use proof.

## Cuts

The project intentionally cuts breadth to protect the core story. It does not implement multi-user RBAC, database persistence, durable queues, key rotation, signed webhook delivery, tenant provisioning, or a custom approval quorum. Those concerns matter in production, but they are scaling and operations projects rather than prerequisites for demonstrating goal-driven discovery, reusable artifacts, deterministic replay, safety evidence, and human handoff.

The implementation also avoids claiming native desktop or terminal support. What I would build next: a server-held resume store with key rotation, followed by version-aware drift quarantine and reviewed tenant overlays. Only after those controls would I add more surface adapters. Live OpenAI discovery remains optional so assessment and local development work without a secret.
