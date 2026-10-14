import { createDecipheriv, createHash } from 'node:crypto';

/**
 * The inverse of the API's `encryptSecret` (apps/api/src/common/crypto.ts, AES-256-GCM with DATA_ENCRYPTION_KEY):
 * the worker needs it to sign agent webhooks. Kept here, rather than shared, because the worker otherwise
 * has no need of the key's format.
 */
function keyFromEnv(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY ?? '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(raw).digest();
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
