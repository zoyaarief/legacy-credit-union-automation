import assert from "node:assert/strict";
import test from "node:test";
import { deliverAlert, signAlertPayload } from "../lib/alerts/delivery.ts";
import { approvalPolicy, approvalState } from "../lib/auth/approvals.ts";
import { can, configuredAdmins } from "../lib/auth/roles.ts";
import rawCapability from "../capabilities/get-savings-balance.v1.json" with { type: "json" };

test("configured administrators are normalized and role capabilities stay separated", () => {
  assert.deepEqual([...configuredAdmins(" user-a, user-b ,,user-a ")], ["user-a", "user-b"]);
  assert.equal(can("reviewer", "review_artifacts"), true);
  assert.equal(can("reviewer", "operate_jobs"), false);
  assert.equal(can("operator", "operate_jobs"), true);
  assert.equal(can("operator", "review_artifacts"), false);
  assert.equal(can("admin", "dispatch_alerts"), true);
  assert.equal(can("admin", "invoke_capabilities"), true);
  assert.equal(can("admin", "enqueue_jobs"), true);
  assert.equal(can("agent", "submit_artifacts"), true);
});

test("approval quorum is derived from risk and rejects partial or negative decisions", () => {
  assert.deepEqual(approvalPolicy(rawCapability), { riskClass: "read_only", requiredApprovals: 1, separationRequired: false });
  assert.deepEqual(approvalPolicy({ ...rawCapability, policy: { ...rawCapability.policy, risk: "irreversible", requiresHumanApproval: true } }), { riskClass: "irreversible", requiredApprovals: 2, separationRequired: true });
  assert.equal(approvalState(0, 0, 2), "draft");
  assert.equal(approvalState(1, 0, 2), "pending");
  assert.equal(approvalState(2, 0, 2), "approved");
  assert.equal(approvalState(2, 1, 2), "rejected");
});

test("alert signatures are deterministic and payload-bound", async () => {
  const first = await signAlertPayload('{"alert":"waiting"}', "secret");
  const second = await signAlertPayload('{"alert":"waiting"}', "secret");
  const changed = await signAlertPayload('{"alert":"recovered"}', "secret");
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("webhook delivery signs the exact transmitted body and rejects failures", async () => {
  let request;
  await deliverAlert({
    url: "https://alerts.example.test/northstar",
    secret: "delivery-secret",
    payload: { alert: "intervention_waiting", severity: "warning" },
    fetcher: async (url, init) => { request = { url, init }; return new Response(null, { status: 204 }); },
  });
  assert.equal(request.url, "https://alerts.example.test/northstar");
  assert.equal(request.init.headers["Content-Type"], "application/json");
  assert.equal(request.init.headers["X-Northstar-Signature"], `sha256=${await signAlertPayload(request.init.body, "delivery-secret")}`);
  await assert.rejects(() => deliverAlert({ url: "https://alerts.example.test/fail", secret: "secret", payload: {}, fetcher: async () => new Response(null, { status: 503 }) }), /503/);
});
