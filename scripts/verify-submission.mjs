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

const envExample = read(".env.example");
for (const secret of ["OPENAI_API_KEY", "EVIDENCE_ENCRYPTION_KEY", "INVOCATION_SIGNING_KEY", "SCHEDULER_SECRET", "ALERT_WEBHOOK_SECRET"]) {
  assert.match(envExample, new RegExp(`^${secret}=$`, "m"), `${secret} must remain blank in .env.example.`);
}

console.log(`Submission audit passed: ${reportWords} report words, ${reportHeadings.length} required sections, complete evidence set.`);
