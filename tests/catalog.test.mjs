import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listCapabilityCatalog, resolveCapabilityVariant, validateInvocationInputs } from "../lib/automation/catalog.ts";
import { scoreStability } from "../lib/automation/stability.ts";

const artifact = JSON.parse(await readFile(new URL("../capabilities/get-savings-balance.v1.json", import.meta.url), "utf8"));

test("catalog exposes one typed capability with two reviewed variants", () => {
  const [entry] = listCapabilityCatalog(artifact);
  assert.equal(entry.name, "get_savings_balance");
  assert.equal(entry.inputs.memberId.sensitive, true);
  assert.deepEqual(Object.keys(entry.outputs), ["balance", "accountStatus"]);
  assert.deepEqual(entry.variants.map((variant) => variant.id), ["northstar-main", "northstar-east"]);
  assert.ok(entry.variants.every((variant) => variant.reviewState === "approved"));
  assert.equal(new Set(entry.variants.map((variant) => variant.vendorFamily)).size, 1);
});

test("reviewed east variant changes only entry point and named locator overrides", () => {
  const { artifact: resolved } = resolveCapabilityVariant(artifact, "northstar-east");
  assert.equal(resolved.target.entryPoint, "/legacy?variant=east");
  assert.equal(resolved.steps[0].target.locators[0].value, "member_number_east");
  assert.equal(resolved.steps[1].target.locators[0].value, "Find Member");
  assert.deepEqual(resolved.inputs, artifact.inputs);
  assert.deepEqual(resolved.outputs, artifact.outputs);
  assert.deepEqual(resolved.policy, artifact.policy);
});

test("catalog rejects unknown variants and invalid typed inputs", () => {
  assert.throws(() => resolveCapabilityVariant(artifact, "unreviewed"), /not in the reviewed catalog/);
  const { artifact: resolved } = resolveCapabilityVariant(artifact, "northstar-main");
  assert.throws(() => validateInvocationInputs(resolved, { memberId: "abc" }), /declared format/);
  assert.deepEqual(validateInvocationInputs(resolved, { memberId: "12345" }), { memberId: "12345" });
});

test("stability score distinguishes clean, recovered, and failing runs", () => {
  assert.equal(scoreStability(Array.from({ length: 3 }, () => ({ status: "success", attempts: 1, recovered: false }))).label, "stable");
  const recovered = scoreStability([
    { status: "success", attempts: 1, recovered: false },
    { status: "success", attempts: 2, recovered: true },
    { status: "success", attempts: 1, recovered: false },
  ]);
  assert.equal(recovered.label, "needs_review");
  assert.equal(recovered.recoveredRuns, 1);
  assert.equal(scoreStability([
    { status: "failure", attempts: 1, recovered: false },
    { status: "success", attempts: 1, recovered: false },
    { status: "failure", attempts: 1, recovered: false },
  ]).label, "unstable");
  assert.equal(scoreStability([]).successRate, 0);
});
