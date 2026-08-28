import assert from "node:assert/strict";
import test from "node:test";
import { INVOCATION_RATE_LIMIT, rateLimitWindow, summarizeOperations } from "../lib/operations/core.ts";
import { signInvocation, verifyInvocation } from "../lib/security/invocation.ts";

const secret = "HPIeM3q5zhMWWhvVMvhaDDOaHcx1U5k3b2UQlOmcQPw=";
const now = Date.parse("2026-08-28T14:00:00.000Z");
const claims = {
  invocationId: "invocation-1",
  artifactHash: "abc123",
  capabilityName: "get_savings_balance",
  capabilityVersion: "1.1.0",
  variantId: "northstar-main",
  inputs: { memberId: "12345" },
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 120_000).toISOString(),
};

test("signed invocation is owner-bound, tamper-evident, and time-bounded", async () => {
  const signature = await signInvocation("owner-a", claims, secret);
  assert.deepEqual(await verifyInvocation({ ownerId: "owner-a", claims, signature, secret, now: now + 1_000 }), { valid: true });
  assert.equal((await verifyInvocation({ ownerId: "owner-b", claims, signature, secret, now: now + 1_000 })).reason, "signature_invalid");
  assert.equal((await verifyInvocation({ ownerId: "owner-a", claims: { ...claims, variantId: "northstar-east" }, signature, secret, now: now + 1_000 })).reason, "signature_invalid");
  assert.equal((await verifyInvocation({ ownerId: "owner-a", claims, signature, secret, now: now + 120_001 })).reason, "expired");
});

test("signed invocation rejects invalid ticket lifetimes", async () => {
  const longClaims = { ...claims, expiresAt: new Date(now + 600_000).toISOString() };
  const signature = await signInvocation("owner-a", longClaims, secret);
  assert.equal((await verifyInvocation({ ownerId: "owner-a", claims: longClaims, signature, secret, now })).reason, "invalid_lifetime");
});

test("rate-limit windows are deterministic and expose a fixed owner budget", () => {
  const window = rateLimitWindow(now + 31_234);
  assert.equal(Date.parse(window.resetAt) - window.windowStart, 60_000);
  assert.equal(INVOCATION_RATE_LIMIT, 12);
});

test("operational summary derives ticket, run, recovery, and rotation posture", () => {
  const summary = summarizeOperations({
    eventTypes: ["ticket_issued", "ticket_issued", "ticket_verified", "ticket_rejected", "ticket_rejected", "ticket_rate_limited"],
    runSummaries: [{ status: "success" }, { status: "success", recovered: true }, { status: "failure" }],
    currentKeyVersion: "v2",
    staleEvidenceRows: 4,
    previousKeyConfigured: true,
  });
  assert.equal(summary.ticketsIssued, 2);
  assert.equal(summary.ticketsVerified, 1);
  assert.equal(summary.rateLimited, 1);
  assert.equal(summary.successRate, 2 / 3);
  assert.equal(summary.recoveredRuns, 1);
  assert.equal(summary.staleEvidenceRows, 4);
  assert.ok(summary.alerts.some((alert) => alert.code === "success_rate_low"));
  assert.ok(summary.alerts.some((alert) => alert.code === "ticket_rejections_high"));
  assert.ok(summary.alerts.some((alert) => alert.code === "key_rotation_pending"));
});

test("operational alerts surface durable job backlog and waiting interventions", () => {
  const summary = summarizeOperations({ eventTypes: [], runSummaries: [], currentKeyVersion: "v2", staleEvidenceRows: 0, previousKeyConfigured: false,
    jobStatuses: ["queued", "queued", "queued", "queued", "queued", "human_required"] });
  assert.equal(summary.queuedJobs, 5);
  assert.equal(summary.humanRequiredJobs, 1);
  assert.ok(summary.alerts.some((alert) => alert.code === "job_backlog"));
  assert.ok(summary.alerts.some((alert) => alert.code === "intervention_waiting"));
});
