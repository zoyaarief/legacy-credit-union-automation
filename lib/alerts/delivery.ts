function toHex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function signAlertPayload(payload: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}
export async function deliverAlert(options: { url: string; secret: string; payload: Record<string, unknown>; fetcher?: typeof fetch }) {
  const body = JSON.stringify(options.payload); const signature = await signAlertPayload(body, options.secret);
  const response = await (options.fetcher ?? fetch)(options.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Northstar-Signature": `sha256=${signature}` }, body });
  if (!response.ok) throw new Error(`Webhook returned ${response.status}.`);
}
