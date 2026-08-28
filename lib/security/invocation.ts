export type InvocationSignatureClaims = {
  invocationId: string;
  artifactHash: string;
  capabilityName: string;
  capabilityVersion: string;
  variantId: string;
  inputs: Record<string, string>;
  issuedAt: string;
  expiresAt: string;
};

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
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

async function importSigningKey(secret: string) {
  const raw = fromBase64(secret);
  if (raw.byteLength !== 32) throw new Error("Invocation signing key must contain exactly 32 bytes.");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function calculateSignature(ownerId: string, claims: InvocationSignatureClaims, secret: string) {
  const key = await importSigningKey(secret);
  const payload = new TextEncoder().encode(canonicalize({ ownerId, ...claims }));
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, payload)));
}

export async function signInvocation(ownerId: string, claims: InvocationSignatureClaims, secret: string): Promise<string> {
  return calculateSignature(ownerId, claims, secret);
}

function constantTimeEqual(left: string, right: string) {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export async function verifyInvocation(options: {
  ownerId: string;
  claims: InvocationSignatureClaims;
  signature: string;
  secret: string;
  now?: number;
  maxLifetimeMs?: number;
}): Promise<{ valid: true } | { valid: false; reason: "expired" | "invalid_lifetime" | "signature_invalid" }> {
  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(options.claims.issuedAt);
  const expiresAt = Date.parse(options.claims.expiresAt);
  const maxLifetimeMs = options.maxLifetimeMs ?? 300_000;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeMs || issuedAt > now + 30_000) {
    return { valid: false, reason: "invalid_lifetime" };
  }
  if (expiresAt <= now) return { valid: false, reason: "expired" };
  const expected = await calculateSignature(options.ownerId, options.claims, options.secret);
  return constantTimeEqual(expected, options.signature) ? { valid: true } : { valid: false, reason: "signature_invalid" };
}
