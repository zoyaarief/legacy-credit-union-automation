# Legacy Credit Union Computer-Use Automation

The submission-ready system implements the complete discovery → capability → deterministic replay → human handoff path, with security, evidence, and optional production controls around it.

## What works

- Goal form and live legacy-credit-union target session
- Observe–decide–act discovery over a sanitized live DOM control inventory, with an eight-step and 20-second policy budget
- Optional OpenAI Responses API provider using structured JSON and `store: false`
- Explicit safe-simulator fallback only when the server declares that no API key is configured; network and provider failures remain visible
- Observation-local control references plus DOM-derived locator candidates; no preassigned workflow target catalog
- Strict action, observed-locator, input, output, route, and sensitive-value validation
- Positive classification against the exact supported capability, with `unsupported_goal` rejection before navigation for every other intent
- Automatic compilation into the versioned capability schema
- Generated-artifact review and an enforced `draft → approved` gate bound to its SHA-256 fingerprint
- Known `member_not_found` business outcome and final checkpoint verification
- Visibility-, enabled-state-, and uniqueness-aware locator resolution
- Redacted discovery and replay evidence; model transcripts are discarded
- Explicit `automation → human_requested → human → resuming → completed` ownership model
- Restricted-account intervention with a redacted surface snapshot
- Human action capture without field values and deterministic same-session resume during both discovery and replay
- Per-user D1 run history with SHA-256 evidence integrity, 7/30/90-day expiry, deletion, and restorable capability artifacts
- Injected session-expiry, slow-load timeout, and application-error paths
- One clean retry for allowlisted recoverable failures; hard failures are never retried
- AES-256-GCM evidence encryption in hosted storage with owner/run/hash authenticated context
- Authenticated `GET/POST /api/capabilities` contract with typed inputs and outputs
- Fingerprint-verified invocation tickets that feed the existing deterministic browser executor
- Reviewed main and east-branch tenant profiles within one canonical vendor family
- Three-run live canary scoring with stable, needs-review, and unstable classifications
- HMAC-SHA-256 invocation signatures with a 120-second lifetime and server verification before execution
- Atomic D1 rate limits of 12 ticket issues per owner per minute
- Owner-scoped 24-hour telemetry for tickets, rejections, agent runs, outcomes, and recoveries
- Current/previous evidence keyring support with bounded re-encryption batches
- Owner-scoped asynchronous jobs with encrypted inputs and three-minute worker leases
- Durable `human_required` jobs that can be rehydrated on another signed-in device
- Five alert policies covering success rate, ticket rejection, backlog, waiting intervention, and key rotation
- Server-enforced administrator, reviewer, operator, agent, and viewer capabilities
- Reviewer-only artifact approval and operator-only durable job execution
- Protected scheduler tick for expired-lease recovery and alert-outbox dispatch
- HMAC-SHA-256 webhook delivery with deduplication and exponential retry
- Risk-derived approval quorum: one reviewer for read-only work and two independent reviewers for risky work
- Submitter self-approval blocked whenever separation of duties is required
- Durable approve/reject decisions with fingerprint-bound reviewer progress
- Executor-level fingerprint and quorum verification for risky approval grants
- Reviewer queue and administrator role-assignment controls in the console
- Unit coverage for replay, recovery, encryption, discovery, hostile reordered surfaces, invented-locator rejection, model validation, storage policy, artifact fingerprints, fault classification, and handoff transitions
- Automated browser E2E coverage for semantic goal rejection, discovery handoff/resume, successful replay, locator evidence, checkpoints, and business outcomes

## Run locally

Requires Node.js 22.13+ and pnpm.

```bash
pnpm install
cp .env.example .env.local
pnpm run dev
```

`OPENAI_API_KEY` is optional. Without it, discovery uses the labeled safe simulator and the complete discovery-to-replay flow still works locally. Never commit `.env.local`.

`EVIDENCE_ENCRYPTION_KEY` is optional only on localhost and must be a base64-encoded 32-byte key. Hosted production requires it; `EVIDENCE_KEY_VERSION` identifies the active key version.

`INVOCATION_SIGNING_KEY` is required for agent tickets and must be a separate base64-encoded 32-byte key. During evidence rotation, configure the previous key and version, deploy the new current key, then use the Operations control to re-encrypt remaining rows before removing the previous key.

`AUTOMATION_ADMIN_USER_IDS` bootstraps trusted administrators. `SCHEDULER_SECRET` protects machine-triggered control ticks. Configure both `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_SECRET` to enable external delivery; without them, alerts remain safely queued.

Open `http://localhost:3000`.

## Demo path

Start the application:

```bash
pnpm run dev
```

Then open `http://localhost:3000` and run this exact flow:

1. In **Discover**, keep the supplied goal, use member `12345`, and select **Discover capability**.
2. In **Discover**, use member `31415`, accept discovery control, click **Continue lookup** inside the live target, and resume discovery in the same session.
3. Approve the generated artifact, switch to **Replay**, and select **Run capability**. The structured result must return `$2,458.17`, `Active`, and a verified checkpoint.
4. Replay member `00000`. The result must be the `member_not_found` business outcome, not a failure.
5. Replay `12345` with **session expired**. The run must recover once and then succeed. **Application error** must stop without retry.
6. Open **Human handoff**, start the assisted replay, accept control, click **Continue lookup** inside the live target, and resume automation.
7. Open **Agent API**, invoke the reviewed tenant capability, run the three-canary score, and optionally enqueue the invocation.

Without `OPENAI_API_KEY`, step 1 is clearly labeled `safe-simulator`. With the key configured, the same flow uses the server-only OpenAI decision provider.

## Verify

```bash
pnpm run verify:submission
pnpm run evidence:generate
pnpm test
pnpm run test:e2e
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Project map

- `app/page.tsx` — discovery, replay, handoff, agent catalog console, and browser adapters
- `app/api/capabilities/route.ts` — authenticated catalog and typed invocation-ticket API
- `app/api/operations/route.ts` — owner-scoped telemetry and bounded evidence-key rotation
- `app/api/jobs/route.ts` — encrypted durable jobs, leasing, claiming, completion, and cancellation
- `app/api/roles/route.ts` — authenticated role resolution and administrator-managed assignments
- `app/api/scheduler/route.ts` — lease recovery and signed retrying alert dispatch
- `app/api/discovery/decide/route.ts` — server-only discovery provider boundary
- `app/api/runs/route.ts` — authenticated durable history, expiry, integrity hashes, and deletion
- `app/api/artifacts/route.ts` — fingerprint-scoped review requests, quorum, and durable decisions
- `app/legacy/page.tsx` — synthetic legacy credit-union application
- `db/` and `drizzle/` — D1 schema, access helper, and migration
- `lib/discovery/` — discovery engine, provider validation, and OpenAI adapter
- `lib/automation/core.ts` — pausable deterministic executor and evidence contracts
- `lib/automation/catalog.ts` — reviewed vendor/tenant profiles and invocation validation
- `lib/automation/stability.ts` — multi-run stability scoring
- `lib/operations/` — durable rate limits, telemetry events, and health summaries
- `lib/security/invocation.ts` — owner-bound HMAC ticket signing and verification
- `lib/security/fingerprint.ts` — canonical SHA-256 fingerprints shared by review and execution
- `lib/auth/roles.ts` — server-side role capabilities and authorization policy
- `lib/alerts/delivery.ts` — exact-body webhook signing and delivery
- `lib/jobs/core.ts` — durable job contracts
- `lib/handoff/` — control-transfer state machine
- `capabilities/` — reviewed runtime capability artifacts
- `evidence/` — saved capability plus redacted discovery, replay, failure, handoff, and policy evidence
- `tests/` — replay and discovery tests
- `REPORT.md` — design decisions and phase cut line

## Submission

Before publishing the repository, run the complete **Verify** block from a clean checkout. The remaining external steps are to create the public GitHub repository, optionally configure a live OpenAI key, and send the repository URL using the applicant email address.
