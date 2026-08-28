import { validateCapability, type Capability, type EvidenceEvent } from "../automation/core.ts";
import { redactDiscoveryText, type DiscoveryEvidenceEvent } from "../discovery/core.ts";

export type StoredRunKind = "discovery" | "replay" | "handoff";
export type StoredRunStatus = "success" | "business_outcome" | "human_required" | "failure";

export type RunRecordInput = {
  runId: string;
  kind: StoredRunKind;
  status: StoredRunStatus;
  artifactName: string;
  artifactVersion: string;
  provider?: string;
  summary: Record<string, unknown>;
  evidence: Array<EvidenceEvent | DiscoveryEvidenceEvent>;
  artifact?: unknown;
  retentionDays?: 7 | 30 | 90;
};

export type RunRecord = RunRecordInput & {
  createdAt: string;
  expiresAt: string;
  evidenceHash: string;
  integrity: "verified" | "mismatch" | "legacy";
  encryption: "aes-gcm" | "legacy-plaintext";
  keyVersion: string | null;
};

export type ArtifactReview = {
  artifactHash: string;
  artifactName: string;
  artifactVersion: string;
  state: "draft" | "approved";
  operatorRole: "reviewer";
  createdAt: string;
  reviewedAt: string | null;
};

function cleanValue(value: unknown): unknown {
  if (typeof value === "string") return redactDiscoveryText(value).slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 100).map(cleanValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, cleanValue(item)]));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null;
}

export function sanitizeRunRecord(value: unknown): RunRecordInput {
  if (!value || typeof value !== "object") throw new Error("Run record must be an object.");
  const input = value as Record<string, unknown>;
  if (typeof input.runId !== "string" || input.runId.length < 3 || input.runId.length > 100) throw new Error("Run id is invalid.");
  if (!['discovery', 'replay', 'handoff'].includes(String(input.kind))) throw new Error("Run kind is invalid.");
  if (!['success', 'business_outcome', 'human_required', 'failure'].includes(String(input.status))) throw new Error("Run status is invalid.");
  if (typeof input.artifactName !== "string" || typeof input.artifactVersion !== "string") throw new Error("Artifact identity is required.");
  if (!Array.isArray(input.evidence) || input.evidence.length > 100) throw new Error("Evidence is invalid.");

  let artifact: Capability | undefined;
  if (input.artifact !== undefined) {
    artifact = cleanValue(validateCapability(input.artifact)) as Capability;
  }
  return {
    runId: input.runId,
    kind: input.kind as StoredRunKind,
    status: input.status as StoredRunStatus,
    artifactName: String(input.artifactName).slice(0, 100),
    artifactVersion: String(input.artifactVersion).slice(0, 40),
    provider: typeof input.provider === "string" ? String(cleanValue(input.provider)).slice(0, 80) : undefined,
    summary: cleanValue(input.summary) as Record<string, unknown>,
    evidence: cleanValue(input.evidence) as Array<EvidenceEvent | DiscoveryEvidenceEvent>,
    artifact,
    retentionDays: [7, 30, 90].includes(Number(input.retentionDays)) ? Number(input.retentionDays) as 7 | 30 | 90 : 30,
  };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function capabilityFingerprint(value: unknown): Promise<string> {
  return sha256(cleanValue(validateCapability(value)));
}

export function sanitizeCapabilityForStorage(value: unknown): Capability {
  return cleanValue(validateCapability(value)) as Capability;
}
