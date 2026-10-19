import { describe, expect, it } from 'vitest';
import { apiSecurityHeaders } from './security-headers';

function headersFor() {
  const set: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => void (set[k.toLowerCase()] = v), removeHeader: () => undefined };
  apiSecurityHeaders()({} as never, res as never, () => undefined);
  return set;
}

describe('apiSecurityHeaders', () => {
  it('leaves Strict-Transport-Security to the https front door', () => {
    expect(headersFor()['strict-transport-security']).toBeUndefined();
  });

  it('still sends the other helmet headers', () => {
    const h = headersFor();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-security-policy']).toBeDefined();
  });
});
