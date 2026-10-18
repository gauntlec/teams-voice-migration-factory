import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { describe, expect, it } from 'vitest';
import { JwksCache } from './jwks-cache';
import { OidcClient, createPkce, isAllowedEndpoint } from './oidc-client';
import { OidcError, type OidcFailure } from './oidc-error';
import { readState, signState, type OidcState } from './state-cookie';

const ISSUER = 'https://idp.example.com';
const CLIENT = 'client-123';
const NONCE = 'nonce-abc';
const NOW = Date.parse('2026-10-18T12:00:00Z');
const nowSec = Math.floor(NOW / 1000);

interface TestKey { kid: string; alg: string; privateKey: KeyLike; jwk: JWK }
async function makeKey(alg: 'RS256' | 'ES256' | 'EdDSA', kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return { kid, alg, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

/** A fake provider's key endpoint: the keys can be swapped to simulate rotation, and every fetch is counted. */
function jwksServer(keys: () => TestKey[]) {
  const calls = { n: 0 };
  const fetchFn = (async () => {
    calls.n++;
    return new Response(JSON.stringify({ keys: keys().map((k) => k.jwk) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: CLIENT, sub: 'user-1', nonce: NONCE, email: 'a@example.com', email_verified: true, name: 'A', jti: 'jti-1',
  iat: nowSec - 5, exp: nowSec + 300, amr: ['pwd', 'otp', 'mfa'], ...over,
});

async function sign(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const jwt = new SignJWT(payload as never).setProtectedHeader({ alg: key.alg, kid: key.kid, ...header });
  return jwt.sign(key.privateKey);
}

async function setup() {
  const key = await makeKey('ES256', 'k1');
  const server = jwksServer(() => [key]);
  const jwks = new JwksCache({ fetchFn: server.fetchFn, now: () => NOW, refreshCooldownMs: 10_000 });
  const client = new OidcClient({ fetchFn: server.fetchFn, now: () => NOW, jwks });
  const doc = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` };
  const reg = { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', scopes: 'openid email profile' };
  const verify = (token: string, requireMfa = true) => client.verify(token, doc, reg, { nonce: NONCE, requireMfa });
  return { key, server, jwks, client, doc, reg, verify };
}

async function reason(p: Promise<unknown>): Promise<OidcFailure | 'accepted'> {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    if (e instanceof OidcError) return e.reason;
    throw e;
  }
}

describe('ID token verification', () => {
  it('accepts a good token signed with each allowed algorithm', async () => {
    for (const alg of ['RS256', 'ES256', 'EdDSA'] as const) {
      const key = await makeKey(alg, `k-${alg}`);
      const server = jwksServer(() => [key]);
      const client = new OidcClient({ fetchFn: server.fetchFn, now: () => NOW });
      const doc = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, jwks_uri: `${ISSUER}/jwks` };
      const t = await client.verify(await sign(key, claims()), doc, { issuer: ISSUER, clientId: CLIENT, clientSecret: null, scopes: 'openid' }, { nonce: NONCE, requireMfa: true });
      expect(t).toMatchObject({ subject: 'user-1', email: 'a@example.com', emailVerified: true, jti: 'jti-1', amr: ['pwd', 'otp', 'mfa'] });
    }
  });

  it('refuses a token for another audience, issuer or nonce', async () => {
    const s = await setup();
    expect(await reason(s.verify(await sign(s.key, claims({ aud: 'someone-else' }))))).toBe('token_audience');
    expect(await reason(s.verify(await sign(s.key, claims({ iss: 'https://evil.example.com' }))))).toBe('token_issuer');
    expect(await reason(s.verify(await sign(s.key, claims({ nonce: 'other' }))))).toBe('token_nonce');
    expect(await reason(s.verify(await sign(s.key, claims({ nonce: undefined }))))).toBe('token_nonce');
  });

  it('accepts an audience list that includes us, but then needs azp to be us', async () => {
    const s = await setup();
    expect(await reason(s.verify(await sign(s.key, claims({ aud: [CLIENT, 'other'], azp: CLIENT }))))).toBe('accepted');
    expect(await reason(s.verify(await sign(s.key, claims({ aud: [CLIENT, 'other'] }))))).toBe('token_authorized_party');
    expect(await reason(s.verify(await sign(s.key, claims({ aud: [CLIENT, 'other'], azp: 'other' }))))).toBe('token_authorized_party');
  });

  it('refuses expired tokens and tokens from the future, with 60 seconds of tolerance either way', async () => {
    const s = await setup();
    expect(await reason(s.verify(await sign(s.key, claims({ exp: nowSec - 30 }))))).toBe('accepted'); // 30 s late is within the skew
    expect(await reason(s.verify(await sign(s.key, claims({ exp: nowSec - 61 }))))).toBe('token_expired');
    expect(await reason(s.verify(await sign(s.key, claims({ iat: nowSec + 30, exp: nowSec + 400 }))))).toBe('accepted');
    expect(await reason(s.verify(await sign(s.key, claims({ iat: nowSec + 120, exp: nowSec + 500 }))))).toBe('token_not_yet_valid');
    expect(await reason(s.verify(await sign(s.key, claims({ nbf: nowSec + 120 }))))).toBe('token_not_yet_valid');
  });

  it('refuses a token without exp, iat or sub', async () => {
    const s = await setup();
    for (const missing of ['exp', 'iat', 'sub']) {
      expect(await reason(s.verify(await sign(s.key, claims({ [missing]: undefined })))), missing).toBe('token_missing_claim');
    }
  });

  it('refuses alg=none, however it is dressed up', async () => {
    const s = await setup();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    for (const alg of ['none', 'None', 'NONE']) {
      const token = `${b64({ alg, typ: 'JWT', kid: 'k1' })}.${b64(claims())}.`;
      expect(await reason(s.verify(token)), alg).toBe('token_alg_not_allowed');
    }
  });

  it('refuses a shared-secret (HS256) token, including one "signed" with the provider\'s public key', async () => {
    const s = await setup();
    const hs = (secret: Uint8Array) => new SignJWT(claims() as never).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(secret);
    expect(await reason(s.verify(await hs(new TextEncoder().encode('a-shared-secret-that-is-long-enough'))))).toBe('token_alg_not_allowed');
    // The classic confusion attack: HMAC with the bytes of the public key.
    expect(await reason(s.verify(await hs(new TextEncoder().encode(JSON.stringify(s.key.jwk)))))).toBe('token_alg_not_allowed');
    for (const alg of ['HS384', 'HS512']) {
      const t = await new SignJWT(claims() as never).setProtectedHeader({ alg, kid: 'k1' }).sign(new TextEncoder().encode('x'.repeat(64)));
      expect(await reason(s.verify(t)), alg).toBe('token_alg_not_allowed');
    }
  });

  it('refuses a token signed by a key the provider does not publish, and a tampered token', async () => {
    const s = await setup();
    const rogue = await makeKey('ES256', 'k1'); // same kid, different key
    expect(await reason(s.verify(await sign(rogue, claims())))).toBe('token_signature');
    const good = await sign(s.key, claims());
    const [h, p, sig] = good.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify(claims({ sub: 'admin' }))).toString('base64url')}.${sig}`;
    expect(await reason(s.verify(forged))).toBe('token_signature');
    expect(await reason(s.verify('not-a-jwt'))).toBe('token_malformed');
    expect(p).toBeTruthy();
  });

  it('refetches the keys once for an unknown key id (rotation), but not more often than the cooldown', async () => {
    let published: TestKey[] = [];
    const k1 = await makeKey('ES256', 'k1');
    const k2 = await makeKey('ES256', 'k2');
    published = [k1];
    const server = jwksServer(() => published);
    let t = NOW;
    const jwks = new JwksCache({ fetchFn: server.fetchFn, now: () => t, refreshCooldownMs: 10_000 });
    const client = new OidcClient({ fetchFn: server.fetchFn, now: () => NOW, jwks });
    const doc = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, jwks_uri: `${ISSUER}/jwks` };
    const reg = { issuer: ISSUER, clientId: CLIENT, clientSecret: null, scopes: 'openid' };
    const verify = (token: string) => client.verify(token, doc, reg, { nonce: NONCE, requireMfa: true });

    expect(await reason(verify(await sign(k1, claims())))).toBe('accepted');
    expect(server.calls.n).toBe(1);

    // The provider rotates; a token with the new kid arrives straight away: inside the cooldown, so no refetch, refused.
    published = [k1, k2];
    expect(await reason(verify(await sign(k2, claims())))).toBe('unknown_key');
    expect(server.calls.n).toBe(1);

    // After the cooldown the same token triggers exactly one refetch and is accepted.
    t = NOW + 11_000;
    expect(await reason(verify(await sign(k2, claims())))).toBe('accepted');
    expect(server.calls.n).toBe(2);

    // A key id that never existed refetches once, then is refused; repeated bad tokens do not become repeated fetches.
    const ghost = await makeKey('ES256', 'ghost');
    t = NOW + 30_000;
    expect(await reason(verify(await sign(ghost, claims())))).toBe('unknown_key');
    expect(server.calls.n).toBe(3);
    expect(await reason(verify(await sign(ghost, claims())))).toBe('unknown_key');
    expect(server.calls.n).toBe(3);
  });

  it('requires proof of multi-factor only when asked', async () => {
    const s = await setup();
    const pwdOnly = await sign(s.key, claims({ amr: ['pwd'] }));
    expect(await reason(s.verify(pwdOnly, true))).toBe('mfa_not_proven');
    expect(await reason(s.verify(pwdOnly, false))).toBe('accepted');
    expect(await reason(s.verify(await sign(s.key, claims({ amr: undefined })), true))).toBe('mfa_not_proven');
    for (const factor of ['mfa', 'otp', 'hwk']) {
      expect(await reason(s.verify(await sign(s.key, claims({ amr: ['pwd', factor] })), true)), factor).toBe('accepted');
    }
  });

  it('reads email_verified as a real boolean, and tolerates a provider that sends it as a string', async () => {
    const s = await setup();
    expect((await s.verify(await sign(s.key, claims({ email_verified: 'false' })))).emailVerified).toBe(false);
    expect((await s.verify(await sign(s.key, claims({ email_verified: undefined })))).emailVerified).toBeNull();
  });
});

describe('discovery and the code exchange', () => {
  const discoveryDoc = (over: Record<string, unknown> = {}) => ({
    issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, ...over,
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('reads the endpoints, and refuses a document that names a different issuer or a plain-http endpoint', async () => {
    const mk = (doc: unknown) => new OidcClient({ fetchFn: (async () => json(doc)) as unknown as typeof fetch });
    expect((await mk(discoveryDoc()).discover(ISSUER)).token_endpoint).toBe(`${ISSUER}/token`);
    expect(await reason(mk(discoveryDoc({ issuer: 'https://evil.example.com' })).discover(ISSUER))).toBe('issuer_mismatch');
    expect(await reason(mk(discoveryDoc({ token_endpoint: 'http://idp.example.com/token' })).discover(ISSUER))).toBe('insecure_endpoint');
    expect(await reason(mk(discoveryDoc({ jwks_uri: undefined })).discover(ISSUER))).toBe('discovery_failed');
    expect(await reason(new OidcClient({ fetchFn: (async () => json({}, 500)) as unknown as typeof fetch }).discover(ISSUER))).toBe('discovery_failed');
    expect(await reason(mk(discoveryDoc()).discover('http://idp.example.com'))).toBe('insecure_endpoint');
  });

  it('caches the document for an hour', async () => {
    let n = 0;
    let t = NOW;
    const c = new OidcClient({ fetchFn: (async () => (n++, json(discoveryDoc()))) as unknown as typeof fetch, now: () => t });
    await c.discover(ISSUER);
    await c.discover(ISSUER);
    expect(n).toBe(1);
    t += 61 * 60_000;
    await c.discover(ISSUER);
    expect(n).toBe(2);
  });

  it('allows plain http only for a loopback address', () => {
    expect(isAllowedEndpoint('https://idp.example.com/x')).toBe(true);
    expect(isAllowedEndpoint('http://127.0.0.1:9000/x')).toBe(true);
    expect(isAllowedEndpoint('http://localhost/x')).toBe(true);
    for (const bad of ['http://idp.example.com', 'ftp://idp.example.com', 'https://u:p@idp.example.com', 'idp.example.com', 'javascript:alert(1)']) expect(isAllowedEndpoint(bad), bad).toBe(false);
  });

  it('builds the authorization URL with PKCE S256, state and nonce', () => {
    const c = new OidcClient();
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const u = new URL(c.authorizationUrl(discoveryDoc() as never, { clientId: CLIENT, scopes: 'openid email' }, { redirectUri: 'https://app.test/api/auth/oidc/callback', state: 'st', nonce: 'no', codeChallenge: challenge }));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code', client_id: CLIENT, redirect_uri: 'https://app.test/api/auth/oidc/callback', scope: 'openid email', state: 'st', nonce: 'no', code_challenge: challenge, code_challenge_method: 'S256',
    });
  });

  it('sends the client secret in the Authorization header by default, or in the form when the provider only offers that', async () => {
    const seen: { headers: Headers; body: URLSearchParams }[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: new URLSearchParams(init.body as URLSearchParams) });
      return json({ id_token: 'the.id.token' });
    }) as unknown as typeof fetch;
    const c = new OidcClient({ fetchFn });
    const reg = { issuer: ISSUER, clientId: 'my client', clientSecret: 'p@ss/word', scopes: 'openid' };
    const args = { code: 'CODE', redirectUri: 'https://app.test/cb', codeVerifier: 'VERIFIER' };

    expect(await c.exchangeCode(discoveryDoc() as never, reg, args)).toBe('the.id.token');
    expect(seen[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('my+client:p%40ss%2Fword').toString('base64')}`);
    expect(Object.fromEntries(seen[0]!.body)).toEqual({ grant_type: 'authorization_code', code: 'CODE', redirect_uri: 'https://app.test/cb', code_verifier: 'VERIFIER' });

    await c.exchangeCode(discoveryDoc({ token_endpoint_auth_methods_supported: ['client_secret_post'] }) as never, reg, args);
    expect(seen[1]!.headers.get('authorization')).toBeNull();
    expect(seen[1]!.body.get('client_secret')).toBe('p@ss/word');
  });

  it('never puts the secret, the code or the provider\'s answer in an error', async () => {
    const answer = '{"error":"invalid_grant","error_description":"code CODE-SECRET was bad for p@ss"}';
    const c = new OidcClient({ fetchFn: (async () => new Response(answer, { status: 400 })) as unknown as typeof fetch });
    const reg = { issuer: ISSUER, clientId: CLIENT, clientSecret: 'p@ss', scopes: 'openid' };
    const err = await c.exchangeCode(discoveryDoc() as never, reg, { code: 'CODE-SECRET', redirectUri: 'x', codeVerifier: 'V' }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(OidcError);
    expect((err as OidcError).reason).toBe('token_endpoint_error');
    for (const secret of ['p@ss', 'CODE-SECRET', 'invalid_grant']) expect((err as Error).message).not.toContain(secret);
    const none = new OidcClient({ fetchFn: (async () => json({ access_token: 'only' })) as unknown as typeof fetch });
    expect(await reason(none.exchangeCode(discoveryDoc() as never, reg, { code: 'c', redirectUri: 'x', codeVerifier: 'v' }))).toBe('no_id_token');
  });
});

describe('the state cookie', () => {
  const secret = 'access-secret-0123456789abcdef';
  const state: OidcState = { providerId: 'p1', state: 's', nonce: 'n', codeVerifier: 'v', redirectUri: 'https://app.test/api/auth/oidc/callback', returnTo: '/incidents' };

  it('round-trips, and is useless with another secret, tampered, or from a different kind of token', () => {
    const c = signState(state, secret);
    expect(readState(c, secret)).toEqual(state);
    expect(readState(signState({ ...state, testBy: 'admin-1' }, secret), secret)?.testBy).toBe('admin-1');
    expect(readState(c, 'another-secret-0123456789abcdef')).toBeNull();
    const [h, p, s] = c.split('.');
    expect(readState(`${h}.${Buffer.from(JSON.stringify({ ...state, returnTo: '/admin' })).toString('base64url')}.${s}`, secret)).toBeNull();
    expect(p).toBeTruthy();
    expect(readState(undefined, secret)).toBeNull();
    expect(readState('garbage', secret)).toBeNull();
  });
});
