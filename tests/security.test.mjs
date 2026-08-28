import assert from "node:assert/strict";
import test from "node:test";
import { decryptEvidence, encryptEvidence } from "../lib/security/evidence.ts";

const key = Buffer.alloc(32, 7).toString("base64");

test("AES-GCM evidence encryption round trips without plaintext leakage", async () => {
  const evidence = [{ stepId: "policy", detail: "redacted evidence" }];
  const encrypted = await encryptEvidence(evidence, key, "owner:run:hash", "test-v1");
  assert.equal(encrypted.keyVersion, "test-v1");
  assert.equal(encrypted.ciphertext.includes("redacted evidence"), false);
  assert.deepEqual(await decryptEvidence(encrypted, key, "owner:run:hash"), evidence);
});

test("AES-GCM binds evidence to its owner, run, and integrity context", async () => {
  const encrypted = await encryptEvidence([], key, "owner-a:run-1:hash");
  await assert.rejects(() => decryptEvidence(encrypted, key, "owner-b:run-1:hash"));
});
