// Encryption at rest for Slack user tokens (decision #9). One key, AES-256-GCM, a fresh random IV per token.
//
// Why GCM: it is authenticated. Decrypting a ciphertext that was altered (or encrypted with another key)
// fails loudly instead of returning garbage that we would then send to Slack as a token.
// Stored shape: "<iv>.<tag>.<ciphertext>", each base64. The IV is not secret; it only has to be unique.
//
// What this protects: a copy of the database without the key (a leaked dump, a stolen backup).
// What it does not protect: a server that has both, which is the honest tradeoff in DESIGN decision #9.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce size

export class TokenCryptoError extends Error {}

export function tokenEncryptionConfigured(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}

function key(): Buffer {
  const b64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!b64) throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY is not set (generate one: openssl rand -base64 32)");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new TokenCryptoError("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return k;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptToken(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 3) throw new TokenCryptoError("stored token is not iv.tag.ciphertext");
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenCryptoError("cannot decrypt: wrong key or tampered ciphertext");
  }
}
