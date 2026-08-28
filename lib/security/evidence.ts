export type EncryptedEvidence = {
  ciphertext: string;
  iv: string;
  keyVersion: string;
};

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(secret: string) {
  const raw = fromBase64(secret);
  if (raw.byteLength !== 32) throw new Error("Evidence encryption key must contain exactly 32 bytes.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptEvidence(
  evidence: unknown,
  secret: string,
  context: string,
  keyVersion = "v1",
): Promise<EncryptedEvidence> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(JSON.stringify(evidence)),
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv), keyVersion };
}

export async function decryptEvidence(
  encrypted: EncryptedEvidence,
  secret: string,
  context: string,
): Promise<unknown> {
  const key = await importKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(encrypted.iv), additionalData: new TextEncoder().encode(context) },
    key,
    fromBase64(encrypted.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
