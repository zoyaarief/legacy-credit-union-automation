import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const requiredReportHeadings = [
  "Architecture",
  "Artifact schema",
  "Determinism & error handling",
  "Heterogeneity & multi-tenant",
  "Escalation & handoff",
  "Safety",
  "Cuts",
];

for (const file of ["README.md", "REPORT.md", "evidence/get-savings-balance.artifact.json", "evidence/discovery-success.json", "evidence/replay-success.json", "evidence/replay-not-found.json", "evidence/handoff-success.json"]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing required submission file: ${file}`);
}

const report = read("REPORT.md");
const reportHeadings = [...report.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
assert.deepEqual(reportHeadings, requiredReportHeadings, "REPORT.md must use the required headings in order.");
const reportWords = report.trim().split(/\s+/).length;
assert.ok(reportWords >= 700 && reportWords <= 1800, `REPORT.md should stay near 1–3 pages; found ${reportWords} words.`);

const readme = read("README.md");
for (const heading of ["Run locally", "Demo path", "Verify", "Project map", "Submission"]) assert.match(readme, new RegExp(`^## ${heading}$`, "m"));
for (const command of ["pnpm run dev", "pnpm run verify:submission", "pnpm test", "pnpm run typecheck", "pnpm run lint", "pnpm run build"]) assert.ok(readme.includes(command), `README.md is missing ${command}.`);

const artifact = JSON.parse(read("evidence/get-savings-balance.artifact.json"));
const runtimeArtifact = JSON.parse(read("capabilities/get-savings-balance.v1.json"));
assert.deepEqual(artifact, runtimeArtifact, "Saved evidence artifact must match the reviewed runtime artifact.");
assert.equal(artifact.schemaVersion, "1.0");
assert.equal(artifact.name, "get_savings_balance");
assert.ok(Array.isArray(artifact.steps) && artifact.steps.length > 0);
assert.ok(artifact.inputs?.memberId && artifact.outputs?.balance && artifact.checkpoint);

for (const file of ["discovery-success.json", "replay-success.json", "replay-not-found.json", "handoff-success.json"]) {
  const capture = JSON.parse(read(`evidence/${file}`));
  assert.equal(capture.artifact, `${runtimeArtifact.name}@${runtimeArtifact.version}`, `${file} must identify the reviewed runtime artifact.`);
  assert.ok(Array.isArray(capture.result?.evidence) && capture.result.evidence.length > 0, `${file} must include the exact runtime evidence array.`);
  assert.deepEqual(capture.result.evidence.map((event) => event.sequence), capture.result.evidence.map((_, index) => index + 1), `${file} evidence must remain ordered.`);
  assert.ok(capture.result.evidence.every((event) => Number.isFinite(Date.parse(event.at)) && typeof event.detail === "string"), `${file} evidence must include timestamps and details.`);
  assert.equal(JSON.stringify(capture).includes("12345"), false, `${file} must not store the successful member id.`);
  assert.equal(JSON.stringify(capture).includes("00000"), false, `${file} must not store the not-found member id.`);
  assert.equal(JSON.stringify(capture).includes("31415"), false, `${file} must not store the restricted member id.`);
}

const discoveryCapture = JSON.parse(read("evidence/discovery-success.json"));
assert.equal(discoveryCapture.result.artifact.version, runtimeArtifact.version, "Discovered and reviewed artifact versions must agree.");
assert.ok(discoveryCapture.result.evidence.some((event) => event.phase === "decide" && event.provider), "Discovery evidence must include provider decisions.");
const replayCapture = JSON.parse(read("evidence/replay-success.json"));
assert.ok(replayCapture.result.evidence.some((event) => event.action === "extract" && event.detail.includes(" using ")), "Replay evidence must record successful extraction locators.");

const envExample = read(".env.example");
for (const secret of ["OPENAI_API_KEY", "EVIDENCE_ENCRYPTION_KEY", "INVOCATION_SIGNING_KEY", "SCHEDULER_SECRET", "ALERT_WEBHOOK_SECRET"]) {
  assert.match(envExample, new RegExp(`^${secret}=$`, "m"), `${secret} must remain blank in .env.example.`);
}

console.log(`Submission audit passed: ${reportWords} report words, ${reportHeadings.length} required sections, complete evidence set.`);
