# Legacy Credit Union Computer-Use Automation

Phase 3 completes the required end-to-end vertical slice: goal-driven discovery, typed artifact compilation, deterministic replay, durable redacted evidence, and a same-session human handoff that can resume the paused run.

## What works

- Goal form and live legacy-credit-union target session
- Observe–decide–act discovery with an eight-step and 20-second policy budget
- Optional OpenAI Responses API provider using structured JSON and `store: false`
- Explicit safe-simulator fallback when no API key is configured
- Strict action, target, input, output, route, and sensitive-value validation
- Automatic compilation into the versioned capability schema
- Generated-artifact review, JSON download, and immediate deterministic replay
- Known `member_not_found` business outcome and final checkpoint verification
- Redacted discovery and replay evidence; model transcripts are discarded
- Explicit `automation → human_requested → human → resuming → completed` ownership model
- Restricted-account intervention with a redacted surface snapshot
- Human action capture without field values and deterministic same-session resume
- Per-user D1 run history with restorable capability artifacts
- Unit coverage for replay, discovery, model validation, storage sanitization, and handoff transitions

## Run locally

Requires Node.js 22.13+ and pnpm.

```bash
pnpm install
cp .env.example .env.local
pnpm run dev
```

`OPENAI_API_KEY` is optional. Without it, discovery uses the labeled safe simulator and the complete discovery-to-replay flow still works locally. Never commit `.env.local`.

Open `http://localhost:3000`.

- Discover with member `12345`, then replay the generated artifact.
- Use member `00000` to verify the `member_not_found` outcome.
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
- `app/api/runs/route.ts` — authenticated durable run and artifact history
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

Production hardening: artifact approval states, encrypted evidence retention, role-based operator authorization, and injected session/permission/timeout fault coverage. Deterministic replay remains the production execution path.
