# Legacy Credit Union Computer-Use Automation

Phase 7 adds short-lived owner-bound ticket signatures, durable invocation limits, operational telemetry, and version-aware evidence-key rotation to the complete discovery, approval, replay, recovery, agent invocation, and human-handoff slice.

## What works

- Goal form and live legacy-credit-union target session
- Observe–decide–act discovery with an eight-step and 20-second policy budget
- Optional OpenAI Responses API provider using structured JSON and `store: false`
- Explicit safe-simulator fallback when no API key is configured
- Strict action, target, input, output, route, and sensitive-value validation
- Automatic compilation into the versioned capability schema
- Generated-artifact review and an enforced `draft → approved` gate bound to its SHA-256 fingerprint
- Known `member_not_found` business outcome and final checkpoint verification
- Redacted discovery and replay evidence; model transcripts are discarded
- Explicit `automation → human_requested → human → resuming → completed` ownership model
- Restricted-account intervention with a redacted surface snapshot
- Human action capture without field values and deterministic same-session resume
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
- Unit coverage for replay, recovery, encryption, discovery, model validation, storage policy, artifact fingerprints, fault classification, and handoff transitions

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

Open `http://localhost:3000`.

- Discover with member `12345`, approve the exact generated artifact, then replay it.
- Use member `00000` to verify the `member_not_found` outcome.
- Select session expiry or slow load to verify one bounded recovery and successful checkpoint completion. Application errors stop without retry.
- Choose a retention window or delete a stored run from the audit trail.
- Open **Human handoff**, start the assisted replay, accept control, click **Continue lookup** inside the live target, then resume automation.
- Open **Agent API**, select a reviewed tenant profile, invoke it, or run the three-canary stability score.
- Open `/legacy` to operate the target manually.

## Verify

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Project map

- `app/page.tsx` — discovery, replay, handoff, agent catalog console, and browser adapters
- `app/api/capabilities/route.ts` — authenticated catalog and typed invocation-ticket API
- `app/api/operations/route.ts` — owner-scoped telemetry and bounded evidence-key rotation
- `app/api/discovery/decide/route.ts` — server-only discovery provider boundary
- `app/api/runs/route.ts` — authenticated durable history, expiry, integrity hashes, and deletion
- `app/api/artifacts/route.ts` — owner-scoped exact-artifact review and approval
- `app/legacy/page.tsx` — synthetic legacy credit-union application
- `db/` and `drizzle/` — D1 schema, access helper, and migration
- `lib/discovery/` — discovery engine, provider validation, and OpenAI adapter
- `lib/automation/core.ts` — pausable deterministic executor and evidence contracts
- `lib/automation/catalog.ts` — reviewed vendor/tenant profiles and invocation validation
- `lib/automation/stability.ts` — multi-run stability scoring
- `lib/operations/` — durable rate limits, telemetry events, and health summaries
- `lib/security/invocation.ts` — owner-bound HMAC ticket signing and verification
- `lib/handoff/` — control-transfer state machine
- `capabilities/` — reviewed capability artifacts
- `evidence/` — redacted example run evidence
- `tests/` — replay and discovery tests
- `REPORT.md` — design decisions and phase cut line

## Next phase

Phase 8: durable asynchronous job execution, resumable cross-device interventions, and alert thresholds over operational telemetry. True reviewer/operator separation still requires multiple authenticated users and remains a deployment concern rather than a simulated identity toggle.
