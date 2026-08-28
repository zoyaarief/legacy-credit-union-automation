# Legacy Credit Union Computer-Use Automation

The current milestone provides a clean deterministic-replay foundation against a local, legacy-style member-servicing UI. It intentionally keeps synthetic financial data local and separates the capability contract, execution policy, and surface adapter.

## What works

- Legacy credit-union target with synthetic member records
- Typed, versioned capability with inputs, outputs, ordered actions, fallback locators, outcomes, and checkpoint
- Reusable executor with runtime artifact and input validation
- Same-origin and route allowlist enforcement before and during replay
- Explicit success, business-outcome, recoverable, policy-denied, and hard-failure contracts
- Redacted structured evidence events
- Browser adapter isolated from the executor core
- Unit coverage for success, not-found, invalid input, policy denial, and checkpoint failure

## Run locally

Requires Node.js 22.13+ and pnpm.

```bash
pnpm install
pnpm run dev
```

Open `http://localhost:3000`.

- Use member `12345`, `24680`, or `31415` for success.
- Use member `00000` for the `member_not_found` business outcome.
- Open `/legacy` to operate the target manually.

## Verify the base

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Project map

- `app/page.tsx` — replay console and browser-surface adapter
- `app/legacy/page.tsx` — synthetic legacy credit-union application
- `lib/automation/core.ts` — artifact validation, guardrails, executor, result and evidence contracts
- `capabilities/get-savings-balance.v1.json` — versioned capability artifact
- `tests/` — artifact and executor tests
- `REPORT.md` — design decisions, trade-offs, and cut line

## Next phase

Add the goal-driven discovery path: accept a goal and target, drive the same surface through an observe-decide-act provider boundary, compile successful actions into this capability schema, and save discovery evidence. The deterministic executor remains the production path and must not call the model.
