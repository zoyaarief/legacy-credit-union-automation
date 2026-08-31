# Northstar Credit Union Computer-Use Automation

A focused end-to-end implementation of goal-driven discovery, reusable typed artifacts, deterministic replay, structured evidence, and same-session human handoff against a synthetic legacy credit-union portal.

The product deliberately demonstrates one capability deeply: look up a member’s savings balance and account status. Discovery inspects the live surface, asks a provider for one constrained action at a time, verifies every selected control and locator against the current observation, and compiles the successful trace. Replay then runs the artifact without model decisions.

## What works

- Goal validation accepts only the supported read-only intent and rejects mutation, transfer, credential, and unrelated requests before target preparation.
- Discovery follows a real observe → decide → act loop over the live iframe surface.
- The default simulator uses the same provider contract as the optional OpenAI Responses API path, so the complete demo works without credentials.
- Model decisions may reference only visible observed controls and must choose two ordered locator candidates sourced from that observation.
- Operator-dialog controls are marked `humanOnly` and rejected by both decision validation and the browser adapter.
- Output controls are semantically bound to their declared field; balance and status require distinct controls and typed value validation.
- Compilation accepts only the verified actions actually executed on the successful trace.
- The JSON artifact declares target policy, typed inputs and outputs, ordered actions, fallback locators, business outcomes, time limits, and a success checkpoint.
- Replay is deterministic and LLM-free, validates the artifact and inputs before acting, enforces same-origin path policy, and records the locator that succeeded.
- Known business outcomes are returned separately from technical failures.
- One bounded retry is available for explicitly recoverable faults; hard failures stop immediately.
- Restricted member `31415` demonstrates both discovery-time and replay-time handoff without discarding the live target session.
- Resume tokens bind the original goal, redacted-input fingerprint, artifact/target, session identity, and stopped step; discovery inputs are locked during human control.
- Evidence is ordered, timestamped, structured, and redacts sensitive member identifiers and human-entered values.
- Declared total timeouts abort cooperative provider and adapter operations, and failures include a sanitized DOM snapshot when the surface is available.
- Capabilities marked irreversible or human-approval-required are blocked before the target surface is touched. An external approval system is intentionally outside this focused demo.

## Run locally

Requirements: Node.js 22.13+ and pnpm. Browser tests additionally require Playwright Chromium.

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env.local
pnpm run dev
```

Open `http://localhost:3000`.

`OPENAI_API_KEY` is optional. Without it, discovery uses the safe local provider simulator. With a key, the server decision route can use the configured `OPENAI_DISCOVERY_MODEL` on localhost. Non-local deployments deliberately fall back to the simulator so this demo cannot become a public paid-model proxy.

## Demo path

1. **Discover:** keep the default read-only goal, allowlisted `/legacy` target, and member `12345`, then select **Discover capability**. Inspect the provider-tagged evidence and compiled `1.2.0` artifact.
2. **Reject unsupported intent:** enter “Terminate the member savings account and report its balance and status.” Discovery returns `unsupported_goal` before preparing the target.
3. **Replay:** open **Replay**, run `12345`, and confirm `$2,458.17`, `Active`, successful locator evidence, and the declared checkpoint.
4. **Business outcome:** replay `00000`. The result is `member_not_found`, not a crash.
5. **Recovery:** select the session-expired fault and replay `12345`. The executor records the first recoverable failure and performs one clean retry.
6. **Hard failure:** select the application-error fault. Replay stops without retrying.
7. **Discovery handoff:** discover with `31415`, accept discovery control, click **Continue lookup** inside the live target, and resume discovery. The same session compiles the artifact.
8. **Replay handoff:** open **Human handoff**, start assisted replay, accept control, click **Continue lookup** in the target, and resume automation. The same session reaches the checkpoint.

## Verify

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:e2e
pnpm run evidence:generate
pnpm run verify:submission
```

Playwright starts Vinext on `127.0.0.1`, forces the deterministic simulator even if an ambient API key exists, and uses Playwright-managed Chromium. Evidence generation is deterministic: rerunning it should not change the committed JSON files.

## Project map

- `app/page.tsx` — focused discovery, replay, evidence, and handoff console.
- `app/legacy/page.tsx` — synthetic legacy member-services surface and fault modes.
- `app/api/discovery/decide/route.ts` — optional server-side OpenAI decision provider.
- `lib/discovery/core.ts` — goal policy, observation-bound decision validation, trace execution, resume, and artifact compilation.
- `lib/discovery/provider-client.ts` — live provider client with an explicit simulator fallback.
- `lib/automation/core.ts` — artifact validation, deterministic executor, policy enforcement, evidence, and bounded recovery.
- `lib/browser/live-surface.ts` — browser adapters that observe and operate the embedded legacy surface.
- `lib/handoff/core.ts` — ownership state machine and redacted human-action recording.
- `capabilities/get-savings-balance.v1.json` — reviewed baseline artifact.
- `tests/` — unit coverage and three end-to-end browser scenarios.
- `evidence/` — reviewed baseline plus discovery, exact-generated-artifact replay, business-outcome, handoff, sanitized failure, and real-browser captures.

## Submission

- [REPORT.md](./REPORT.md) uses the seven required headings and explains the design decisions and cuts.
- [evidence/get-savings-balance.artifact.json](./evidence/get-savings-balance.artifact.json) is the reviewed runtime artifact.
- [evidence/discovery-success.json](./evidence/discovery-success.json) is an explicitly labeled deterministic provider/adapter fixture exercising the same observation-bound contract as the browser.
- [evidence/replay-success.json](./evidence/replay-success.json) replays the exact `1.2.0` artifact emitted in discovery and captures deterministic success and locator evidence.
- [evidence/replay-not-found.json](./evidence/replay-not-found.json) captures a declared business outcome.
- [evidence/handoff-success.json](./evidence/handoff-success.json) captures pause, human action, resume, and completion.
- [evidence/replay-failure.json](./evidence/replay-failure.json) captures a hard application failure with its sanitized DOM snapshot.
- [evidence/browser-generated-artifact.png](./evidence/browser-generated-artifact.png) is a real Chromium capture of generated-artifact replay; the continuous Playwright test asserts the same path.

This repository is a local assessment demo, not a production banking system. The legacy portal and member records are synthetic.
