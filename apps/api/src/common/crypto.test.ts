import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto';

// A value written before decryptSecret checked lengths, with Node's defaults (12-byte IV, 16-byte tag), under the key below.
const KEY = Buffer.alloc(32, 7).toString('base64');
const STORED = 'AQEBAQEBAQEBAQEB.7aa3rn8jsu5b5u47+oxKtw==.BZXmxfXbzGy0srNTFRcEWc3bcp1g';

describe('decryptSecret', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = saved;
  });

  it('still reads a value stored with the default 12-byte IV and 16-byte tag', () => {
    expect(decryptSecret(STORED)).toBe('stored before the fix');
  });

  it('reads back what encryptSecret writes', () => {
    expect(decryptSecret(encryptSecret('round trip'))).toBe('round trip');
  });

  it('refuses a tag shortened to 4 bytes', () => {
    const [iv, tag, data] = STORED.split('.');
    const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptSecret([iv, short, data].join('.'))).toThrow('malformed ciphertext');
  });

  it('refuses an IV that is not 12 bytes', () => {
    const [, tag, data] = STORED.split('.');
    expect(() => decryptSecret([Buffer.alloc(16, 1).toString('base64'), tag, data].join('.'))).toThrow('malformed ciphertext');
  });

  it('refuses a tampered value', () => {
    const [iv, tag, data] = STORED.split('.');
    const bytes = Buffer.from(data, 'base64');
    bytes[0] ^= 1;
    expect(() => decryptSecret([iv, tag, bytes.toString('base64')].join('.'))).toThrow();
  });
});
