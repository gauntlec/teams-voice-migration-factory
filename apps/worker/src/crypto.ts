import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The inverse of the API's `encryptSecret` (apps/api/src/common/crypto.ts, AES-256-GCM with DATA_ENCRYPTION_KEY):
 * the worker needs it to sign agent webhooks. Kept here, rather than shared, because the worker otherwise
 * has no need of the key's format.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFromEnv(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY ?? '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(raw).digest();
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  // Only the lengths encryptSecret writes (Node's defaults): GCM would otherwise accept a shortened tag, which is easier to forge.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** The inverse of decryptSecret, the same format as the API's encryptSecret: the worker keeps the Kuma administrator's password it generates. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
