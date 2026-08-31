const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 15 * 60_000;

type TokenEnvelope<T> = {
  version: typeof TOKEN_VERSION;
  purpose: string;
  issuedAt: number;
  expiresAt: number;
  state: T;
};

const signingKey = crypto.subtle.importKey(
  "raw",
  crypto.getRandomValues(new Uint8Array(32)),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Malformed token encoding.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function signResumeState<T>(purpose: string, state: T): Promise<string> {
  const issuedAt = Date.now();
  const payload = new TextEncoder().encode(JSON.stringify({
    version: TOKEN_VERSION,
    purpose,
    issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_MS,
    state,
  } satisfies TokenEnvelope<T>));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey, payload));
  return `${toBase64Url(payload)}.${toBase64Url(signature)}`;
}

export async function verifyResumeState<T>(purpose: string, token: string): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed resume token.");
  const payload = fromBase64Url(parts[0]);
  const signature = fromBase64Url(parts[1]);
  if (!(await crypto.subtle.verify("HMAC", await signingKey, asArrayBuffer(signature), asArrayBuffer(payload)))) {
    throw new Error("Resume token signature is invalid.");
  }
  const envelope = JSON.parse(new TextDecoder().decode(payload)) as Partial<TokenEnvelope<T>>;
  if (
    envelope.version !== TOKEN_VERSION
    || envelope.purpose !== purpose
    || typeof envelope.issuedAt !== "number"
    || typeof envelope.expiresAt !== "number"
    || envelope.expiresAt <= Date.now()
    || envelope.state === undefined
  ) {
    throw new Error("Resume token claims are invalid or expired.");
  }
  return envelope.state;
}
