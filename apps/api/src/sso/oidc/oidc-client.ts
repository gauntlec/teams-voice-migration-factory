import { createHash, randomBytes } from 'node:crypto';
import { JwksCache } from './jwks-cache';
import { verifyIdToken, type IdTokenExpectation, type VerifiedIdToken } from './id-token';
import { OidcError } from './oidc-error';

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface OidcClientRegistration {
  issuer: string;
  clientId: string;
  /** Never logged, never returned. */
  clientSecret: string | null;
  scopes: string;
}

export interface OidcClientOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** How long a discovery document is trusted before it is fetched again. */
  discoveryTtlMs?: number;
  jwks?: JwksCache;
}

/** https only, except a loopback address for local testing. Keeps a provider's documents and tokens off plain http. */
export function isAllowedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE (RFC 7636), method S256. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const formEncode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');

/**
 * The relying-party half of OpenID Connect, kept small on purpose: discovery, the authorization URL (code flow + PKCE S256), the
 * server-to-server code exchange and ID token verification. Nothing here reads or writes the database; the sign-in rules (users, roles,
 * ceilings) live in the sign-in service. Secrets and tokens are never put in an error message.
 */
export class OidcClient {
  readonly jwks: JwksCache;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly discoveryTtl: number;
  private readonly discovered = new Map<string, { doc: DiscoveryDocument; at: number }>();

  constructor(opts: OidcClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.discoveryTtl = opts.discoveryTtlMs ?? 60 * 60_000;
    this.jwks = opts.jwks ?? new JwksCache({ fetchFn: opts.fetchFn, now: opts.now, timeoutMs: opts.timeoutMs });
  }

  forget(issuer: string): void {
    this.discovered.delete(issuer);
  }

  /** The provider's endpoints from `<issuer>/.well-known/openid-configuration`. The issuer in the document must be the one configured. */
  async discover(issuer: string): Promise<DiscoveryDocument> {
    const cached = this.discovered.get(issuer);
    if (cached && this.now() - cached.at < this.discoveryTtl) return cached.doc;
    if (!isAllowedEndpoint(issuer)) throw new OidcError('insecure_endpoint', 'issuer');
    let body: Record<string, unknown>;
    try {
      const res = await this.fetchFn(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      body = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw new OidcError('discovery_failed', (err as Error).message.slice(0, 80));
    }
    // Compare ignoring only a trailing slash, as providers differ on it; anything else must match exactly.
    if (typeof body.issuer !== 'string' || body.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw new OidcError('issuer_mismatch');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      const v = body[key];
      if (typeof v !== 'string') throw new OidcError('discovery_failed', `missing ${key}`);
      if (!isAllowedEndpoint(v)) throw new OidcError('insecure_endpoint', key);
    }
    const methods = Array.isArray(body.token_endpoint_auth_methods_supported) ? body.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string') : undefined;
    const doc: DiscoveryDocument = {
      issuer,
      authorization_endpoint: body.authorization_endpoint as string,
      token_endpoint: body.token_endpoint as string,
      jwks_uri: body.jwks_uri as string,
      token_endpoint_auth_methods_supported: methods,
    };
    this.discovered.set(issuer, { doc, at: this.now() });
    return doc;
  }

  authorizationUrl(
    doc: DiscoveryDocument,
    reg: Pick<OidcClientRegistration, 'clientId' | 'scopes'>,
    p: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
  ): string {
    const u = new URL(doc.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', reg.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('scope', reg.scopes);
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  /** Server-to-server: trades the authorization code (with the PKCE verifier and this client's secret) for the ID token. */
  async exchangeCode(doc: DiscoveryDocument, reg: OidcClientRegistration, p: { code: string; redirectUri: string; codeVerifier: string }): Promise<string> {
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (reg.clientSecret) {
      const methods = doc.token_endpoint_auth_methods_supported;
      // client_secret_basic is the default when a provider does not say; use the form field only when it offers that and not basic.
      if (!methods || methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
        headers.authorization = `Basic ${Buffer.from(`${formEncode(reg.clientId)}:${formEncode(reg.clientSecret)}`).toString('base64')}`;
      } else {
        form.set('client_id', reg.clientId);
        form.set('client_secret', reg.clientSecret);
      }
    } else {
      form.set('client_id', reg.clientId);
    }
    let body: Record<string, unknown>;
    try {
      const res = await this.fetchFn(doc.token_endpoint, { method: 'POST', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new OidcError('token_endpoint_error', `status ${res.status}`);
      body = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof OidcError) throw err;
      throw new OidcError('token_endpoint_error', 'no usable answer');
    }
    if (typeof body.id_token !== 'string' || !body.id_token) throw new OidcError('no_id_token');
    return body.id_token;
  }

  verify(idToken: string, doc: DiscoveryDocument, reg: OidcClientRegistration, p: { nonce: string; requireMfa: boolean }): Promise<VerifiedIdToken> {
    const expect: IdTokenExpectation = { issuer: reg.issuer, clientId: reg.clientId, nonce: p.nonce, requireMfa: p.requireMfa, jwksUri: doc.jwks_uri, now: this.now };
    return verifyIdToken(idToken, this.jwks, expect);
  }
}
