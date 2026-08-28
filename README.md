# Legacy Credit Union Computer-Use Automation

Phase 2 adds goal-driven discovery to the deterministic replay foundation. A constrained provider observes the synthetic legacy portal, proposes one allowlisted action at a time, and compiles a successful trace into a typed capability artifact. Replay then runs that artifact without model decisions.

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
- Unit coverage for replay, discovery, model-boundary validation, and fallback behavior

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
- Open `/legacy` to operate the target manually.

## Verify

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Project map

- `app/page.tsx` — discovery/replay console and browser adapters
- `app/api/discovery/decide/route.ts` — server-only discovery provider boundary
- `app/legacy/page.tsx` — synthetic legacy credit-union application
- `lib/discovery/` — discovery engine, provider validation, and OpenAI adapter
- `lib/automation/core.ts` — deterministic executor and evidence contracts
- `capabilities/` — reviewed capability artifacts
- `evidence/` — redacted example run evidence
- `tests/` — replay and discovery tests
- `REPORT.md` — design decisions and phase cut line

## Next phase

Persist evidence and artifacts behind an authenticated store, then add explicit same-session human takeover and resume states. Deterministic replay remains the production execution path.
