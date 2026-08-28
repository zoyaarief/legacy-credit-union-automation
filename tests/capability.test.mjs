import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL("../capabilities/get-savings-balance.v1.json", import.meta.url);

test("capability declares a complete deterministic contract", async () => {
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));

  assert.equal(artifact.schemaVersion, "1.0");
  assert.equal(artifact.name, "get_savings_balance");
  assert.equal(artifact.target.surface, "web");
  assert.equal(artifact.target.allowlist.sameOrigin, true);
  assert.equal(artifact.inputs.memberId.sensitive, true);
  assert.deepEqual(Object.keys(artifact.outputs), ["balance", "accountStatus"]);
  assert.equal(artifact.policy.risk, "read_only");
  assert.ok(artifact.policy.maxSteps >= artifact.steps.length);
  assert.ok(artifact.policy.runTimeoutMs > 0);
  assert.ok(artifact.steps.length >= 5);
  assert.ok(artifact.steps.every((step) => artifact.policy.allowedActions.includes(step.action)));
  assert.ok(artifact.steps.filter((step) => step.target).every((step) => step.target.locators.length >= 2));
  assert.equal(artifact.businessOutcomes[0].code, "member_not_found");
});

test("artifact never contains synthetic member records", async () => {
  const artifact = await readFile(artifactUrl, "utf8");
  for (const memberId of ["12345", "24680", "31415"]) {
    assert.equal(artifact.includes(memberId), false);
  }
});
