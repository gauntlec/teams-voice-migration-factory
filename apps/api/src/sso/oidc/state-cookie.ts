import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';

/** What the browser carries between "go to the provider" and "back from the provider": the values only this browser may complete the sign-in with. */
export interface OidcState {
  providerId: string;
  /** The `state` parameter sent to the provider and expected back. */
  state: string;
  nonce: string;
  codeVerifier: string;
  /** The exact redirect URI used in the authorization request; the code exchange must repeat it. */
  redirectUri: string;
  /** A path inside the application to land on after signing in. */
  returnTo: string;
  /** Set for "Test sign-in": the administrator who started it. No session is created, nothing is changed except the test result. */
  testBy?: string;
}

export const STATE_COOKIE = 'tvmf_oidc';
export const STATE_TTL_SECONDS = 600;

/** A key only used for this cookie, derived from the access-token secret, so a state cookie can never be mistaken for any other token. */
const key = (secret: string) => createHmac('sha256', 'tvmf-oidc-state').update(secret).digest();

export function signState(s: OidcState, secret: string): string {
  return jwt.sign({ ...s, typ: 'oidc-state' }, key(secret), { algorithm: 'HS256', expiresIn: STATE_TTL_SECONDS, issuer: 'tvmf-oidc' });
}

/** The state from a cookie, or null when it is missing, forged, expired or not a state cookie. */
export function readState(cookie: string | undefined, secret: string): OidcState | null {
  if (!cookie) return null;
  try {
    const p = jwt.verify(cookie, key(secret), { algorithms: ['HS256'], issuer: 'tvmf-oidc' }) as Record<string, unknown>;
    if (p.typ !== 'oidc-state') return null;
    const need = ['providerId', 'state', 'nonce', 'codeVerifier', 'redirectUri', 'returnTo'] as const;
    if (need.some((k) => typeof p[k] !== 'string' || !p[k])) return null;
    return {
      providerId: p.providerId as string,
      state: p.state as string,
      nonce: p.nonce as string,
      codeVerifier: p.codeVerifier as string,
      redirectUri: p.redirectUri as string,
      returnTo: p.returnTo as string,
      ...(typeof p.testBy === 'string' ? { testBy: p.testBy } : {}),
    };
  } catch {
    return null;
  }
}
