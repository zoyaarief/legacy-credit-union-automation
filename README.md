# Legacy Credit Union Computer-Use Automation

Phase 4 hardens the end-to-end vertical slice with exact-artifact approval, tamper-evident evidence, configurable retention, owner-scoped deletion, and explicit replay fault injection.

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
- Unit coverage for replay, discovery, model validation, storage policy, artifact fingerprints, fault classification, and handoff transitions

## Run locally

Requires Node.js 22.13+ and pnpm.

```bash
pnpm install
cp .env.example .env.local
pnpm run dev
```

`OPENAI_API_KEY` is optional. Without it, discovery uses the labeled safe simulator and the complete discovery-to-replay flow still works locally. Never commit `.env.local`.

Open `http://localhost:3000`.

- Discover with member `12345`, approve the exact generated artifact, then replay it.
- Use member `00000` to verify the `member_not_found` outcome.
- Select each fault injection option to verify recoverable session/timeout errors and a hard application failure.
- Choose a retention window or delete a stored run from the audit trail.
- Open **Human handoff**, start the assisted replay, accept control, click **Continue lookup** inside the live target, then resume automation.
- Open `/legacy` to operate the target manually.

## Verify

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Project map

- `app/page.tsx` — discovery, replay, handoff console, and browser adapters
- `app/api/discovery/decide/route.ts` — server-only discovery provider boundary
- `app/api/runs/route.ts` — authenticated durable history, expiry, integrity hashes, and deletion
- `app/api/artifacts/route.ts` — owner-scoped exact-artifact review and approval
- `app/legacy/page.tsx` — synthetic legacy credit-union application
- `db/` and `drizzle/` — D1 schema, access helper, and migration
- `lib/discovery/` — discovery engine, provider validation, and OpenAI adapter
- `lib/automation/core.ts` — pausable deterministic executor and evidence contracts
- `lib/handoff/` — control-transfer state machine
- `capabilities/` — reviewed capability artifacts
- `evidence/` — redacted example run evidence
- `tests/` — replay and discovery tests
- `REPORT.md` — design decisions and phase cut line

## Next phase

Phase 5: separate reviewer/operator roles, managed key-backed evidence encryption, multi-operator approval workflows, and a deployment-grade fault and recovery matrix. Deterministic replay remains the production execution path.
