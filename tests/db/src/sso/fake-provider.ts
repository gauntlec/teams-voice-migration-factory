import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

/**
 * A stand-in OpenID Connect provider for the sign-in tests: discovery, a key set (JWKS) served over http on a loopback port,
 * an authorize step the test performs by hand (the "person" signing in), and a token endpoint that checks the client secret, the
 * redirect URI and PKCE the way a real provider does. Tests can make it misbehave to prove the relying party refuses it.
 */
export interface FakePerson {
  sub: string;
  email?: string | null;
  email_verified?: boolean;
  name?: string;
  amr?: string[];
  /** Extra claims (vx_role, vx_kind, roles...). */
  extra?: Record<string, unknown>;
}

export interface TokenTweaks {
  aud?: string | string[];
  iss?: string;
  nonce?: string | null;
  /** seconds relative to now */
  expOffset?: number;
  iatOffset?: number;
  /** none = unsigned token, HS256 = signed with a shared secret instead of the key pair, wrongKey = a key the provider does not publish */
  alg?: 'none' | 'HS256' | 'wrongKey';
  kid?: string;
  jti?: string | null;
  /** Make the token endpoint answer with this status and no token. */
  tokenStatus?: number;
}

interface Pending { challenge: string; redirectUri: string; nonce: string; person: FakePerson; tweaks: TokenTweaks; used: boolean }

export interface FakeProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The test performs "the person signs in at the provider": returns what the browser would be sent back with. */
  authorize(authorizationUrl: string, person: FakePerson, tweaks?: TokenTweaks): { code: string; state: string };
  /** Publish a new signing key, and optionally stop publishing the old one. */
  rotateKey(opts?: { keepOld?: boolean }): Promise<string>;
  jwksRequests: () => number;
  tokenRequests: () => { auth: string | undefined; body: URLSearchParams }[];
  close(): Promise<void>;
}

interface Key { kid: string; privateKey: KeyLike; jwk: JWK }

async function newKey(): Promise<Key> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `k-${randomUUID().slice(0, 8)}`;
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } };
}

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

export async function startFakeProvider(opts: { clientId?: string; clientSecret?: string } = {}): Promise<FakeProvider> {
  const clientId = opts.clientId ?? `client-${randomUUID().slice(0, 8)}`;
  const clientSecret = opts.clientSecret ?? `secret-${randomUUID()}`;
  let keys: Key[] = [await newKey()];
  const pending = new Map<string, Pending>();
  let jwksCount = 0;
  const tokenCalls: { auth: string | undefined; body: URLSearchParams }[] = [];
  let issuer = '';

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] });
    }
    if (url.pathname === '/jwks') {
      jwksCount++;
      return send(200, { keys: keys.map((k) => k.jwk) });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      tokenCalls.push({ auth: req.headers.authorization, body });
      const expectedAuth = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      if (req.headers.authorization !== expectedAuth) return send(401, { error: 'invalid_client' });
      const p = pending.get(body.get('code') ?? '');
      if (!p || p.used || body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== p.redirectUri) return send(400, { error: 'invalid_grant' });
      if (createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== p.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE' });
      p.used = true;
      if (p.tweaks.tokenStatus) return send(p.tweaks.tokenStatus, { error: 'server_error' });
      return send(200, { access_token: 'unused', token_type: 'Bearer', id_token: await makeToken(p) });
    }
    send(404, { error: 'not_found' });
  });

  async function makeToken(p: Pending): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const t = p.tweaks;
    const payload: Record<string, unknown> = {
      iss: t.iss ?? issuer,
      aud: t.aud ?? clientId,
      sub: p.person.sub,
      iat: now + (t.iatOffset ?? 0),
      exp: now + (t.expOffset ?? 300),
      email: p.person.email === undefined ? `${p.person.sub}@idp.test` : p.person.email,
      email_verified: p.person.email_verified ?? true,
      name: p.person.name ?? 'Test Person',
      amr: p.person.amr ?? ['pwd', 'otp', 'mfa'],
      ...(t.nonce === null ? {} : { nonce: t.nonce ?? p.nonce }),
      ...(t.jti === null ? {} : { jti: t.jti ?? randomUUID() }),
      ...(p.person.extra ?? {}),
    };
    const key = keys[keys.length - 1]!;
    const kid = t.kid ?? key.kid;
    if (t.alg === 'none') {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b64({ alg: 'none', typ: 'JWT', kid })}.${b64(payload)}.`;
    }
    if (t.alg === 'HS256') return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', kid }).sign(new TextEncoder().encode(`shared-${clientSecret}`));
    if (t.alg === 'wrongKey') return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign((await newKey()).privateKey);
    return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(key.privateKey);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    authorize(authorizationUrl, person, tweaks = {}) {
      const u = new URL(authorizationUrl);
      if (u.origin !== issuer || u.pathname !== '/authorize') throw new Error(`not this provider's authorize address: ${u.origin}${u.pathname}`);
      const q = u.searchParams;
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') throw new Error('bad authorization request');
      const code = `code-${randomUUID()}`;
      pending.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')!, person, tweaks, used: false });
      return { code, state: q.get('state')! };
    },
    async rotateKey(o = {}) {
      const k = await newKey();
      keys = o.keepOld === false ? [k] : [...keys, k];
      return k.kid;
    },
    jwksRequests: () => jwksCount,
    tokenRequests: () => tokenCalls,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
