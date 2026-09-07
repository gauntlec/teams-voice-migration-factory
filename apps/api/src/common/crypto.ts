import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for values that must be stored encrypted at rest (currently only
 * TOTP secrets). Customer tenant tokens are never passed through here - they are
 * never persisted at all.
 */
function keyFromEnv(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY ?? '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  // fall back: derive a 32-byte key from whatever was provided (dev convenience)
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Redact obviously-sensitive keys before writing parameters to the audit log. */
const SENSITIVE = /pass(word)?|secret|token|credential|pwd|authorization/i;
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '***' : redact(v);
    }
    return out as T;
  }
  return value;
}
