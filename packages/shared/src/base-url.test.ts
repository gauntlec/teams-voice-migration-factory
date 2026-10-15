import { describe, expect, it } from 'vitest';
import { HOSTED_BASE_URL, baseUrlWarnings, connectDetails, normalizeBaseUrl, setBaseUrlSchema } from './base-url';

describe('base URL', () => {
  it('keeps only the origin, without a trailing slash', () => {
    expect(normalizeBaseUrl(' https://voice.contoso.com/ ')).toEqual({ ok: true, url: 'https://voice.contoso.com' });
    expect(normalizeBaseUrl('HTTPS://Voice.Contoso.com:8443')).toEqual({ ok: true, url: 'https://voice.contoso.com:8443' });
    expect(normalizeBaseUrl(HOSTED_BASE_URL)).toEqual({ ok: true, url: 'https://www.voxshift.io' });
  });

  it('refuses what cannot be the address of the application', () => {
    for (const bad of ['', 'voice.contoso.com', 'ftp://x.example.com', 'https://u:p@x.example.com', 'https://x.example.com/app', 'https://x.example.com/?a=1', 'https://x.example.com/#top']) {
      expect(normalizeBaseUrl(bad).ok, bad).toBe(false);
    }
  });

  it('warns about plain http on a public name, softly on a private one, and not at all for https', () => {
    expect(baseUrlWarnings('https://voice.contoso.com')).toEqual([]);
    expect(baseUrlWarnings('http://voice.contoso.com')[0]).toMatch(/Use https/);
    expect(baseUrlWarnings('http://192.168.200.148:5173')[0]).toMatch(/private network/);
    expect(baseUrlWarnings('http://voxshift')[0]).toMatch(/private network/);
  });

  it('turns blank into "use the default" and rejects a bad address', () => {
    expect(setBaseUrlSchema.parse({ baseUrl: null })).toEqual({ baseUrl: null });
    expect(setBaseUrlSchema.parse({ baseUrl: '  ' })).toEqual({ baseUrl: null });
    expect(setBaseUrlSchema.parse({ baseUrl: 'https://voice.contoso.com/' })).toEqual({ baseUrl: 'https://voice.contoso.com' });
    expect(setBaseUrlSchema.safeParse({ baseUrl: 'nope' }).success).toBe(false);
  });

  it('builds the connection details from the address', () => {
    expect(connectDetails('https://voice.contoso.com')).toEqual({
      voxshiftUrl: 'https://voice.contoso.com',
      agentApi: 'https://voice.contoso.com/api/agent/v1',
      intakeAlerts: 'https://voice.contoso.com/api/intake/v1/alerts',
      inboundEmail: 'https://voice.contoso.com/api/public/inbound-email',
    });
  });
});
