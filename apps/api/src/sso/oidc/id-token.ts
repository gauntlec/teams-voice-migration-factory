import { timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';
import type { JwksCache } from './jwks-cache';
import { OidcError } from './oidc-error';

/** Only asymmetric signatures. `none` and every HS* (shared-secret) algorithm are refused, so a token can never be forged by a key that is public. */
export const ALLOWED_ID_TOKEN_ALGORITHMS = ['RS256', 'ES256', 'EdDSA'] as const;

/** Clock difference tolerated between this installation and the provider, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;

/** `amr` values that prove a second factor (docs/SSO.md 4.2). */
export const MFA_AMR_VALUES = ['mfa', 'otp', 'hwk'] as const;

export interface VerifiedIdToken {
  subject: string;
  issuer: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  amr: string[];
  jti: string | null;
  /** The provider's own id for this sign-in session, when it sends one (`sid`). */
  sessionId: string | null;
  expiresAt: number;
  claims: Record<string, unknown>;
}

export interface IdTokenExpectation {
  issuer: string;
  clientId: string;
  nonce: string;
  /** Refuse unless `amr` proves a second factor. */
  requireMfa: boolean;
  jwksUri: string;
  /** Test hook. */
  now?: () => number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Checks an ID token the way docs/SSO.md 4.2 requires: the signature (allow-listed algorithms only, key by `kid` from the provider's own
 * JWKS), `iss` equal to the provider's issuer, `aud` containing our client id (and `azp` when there are several audiences), `exp`/`nbf`/`iat`
 * within 60 s of skew, the `nonce` we sent, a `sub`, and (when asked) an `amr` that proves multi-factor. Throws OidcError with a reason code.
 */
export async function verifyIdToken(idToken: string, keys: JwksCache, expect: IdTokenExpectation): Promise<VerifiedIdToken> {
  const nowMs = expect.now ? expect.now() : Date.now();

  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(idToken).alg;
  } catch {
    throw new OidcError('token_malformed');
  }
  if (!alg || !(ALLOWED_ID_TOKEN_ALGORITHMS as readonly string[]).includes(alg)) throw new OidcError('token_alg_not_allowed', alg ?? 'none');

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, keys.keyGetter(expect.jwksUri), {
      algorithms: [...ALLOWED_ID_TOKEN_ALGORITHMS],
      issuer: expect.issuer,
      audience: expect.clientId,
      clockTolerance: CLOCK_SKEW_SECONDS,
      currentDate: new Date(nowMs),
      requiredClaims: ['exp', 'iat', 'sub', 'iss', 'aud'],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof OidcError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new OidcError('token_expired');
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.claim === 'iss') throw new OidcError('token_issuer');
      if (err.claim === 'aud') throw new OidcError('token_audience');
      if (err.claim === 'nbf') throw new OidcError('token_not_yet_valid');
      if (err.reason === 'missing') throw new OidcError('token_missing_claim', err.claim);
      throw new OidcError('token_malformed', err.claim);
    }
    if (err instanceof joseErrors.JOSEAlgNotAllowed) throw new OidcError('token_alg_not_allowed', alg);
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) throw new OidcError('token_signature');
    if (err instanceof joseErrors.JOSEError) throw new OidcError(err.code === 'ERR_JWKS_NO_MATCHING_KEY' ? 'unknown_key' : 'token_signature', err.code);
    throw new OidcError('token_malformed');
  }

  // iat must not be in the future (beyond the skew): a token "issued" later than now is forged or the clock is badly wrong.
  const iat = payload.iat;
  if (typeof iat !== 'number' || iat * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000) throw new OidcError('token_not_yet_valid', 'iat');

  const aud = payload.aud;
  if (Array.isArray(aud) && aud.length > 1 && payload.azp !== expect.clientId) throw new OidcError('token_authorized_party');

  const nonce = str(payload.nonce);
  if (!nonce || !sameString(nonce, expect.nonce)) throw new OidcError('token_nonce');

  const sub = str(payload.sub);
  if (!sub) throw new OidcError('token_missing_claim', 'sub');

  const amr = Array.isArray(payload.amr) ? payload.amr.filter((v): v is string => typeof v === 'string') : [];
  if (expect.requireMfa && !amr.some((v) => (MFA_AMR_VALUES as readonly string[]).includes(v))) throw new OidcError('mfa_not_proven');

  const ev = payload.email_verified;
  return {
    subject: sub,
    issuer: expect.issuer,
    email: str(payload.email),
    emailVerified: typeof ev === 'boolean' ? ev : ev === 'true' ? true : ev === 'false' ? false : null,
    name: str(payload.name),
    amr,
    jti: str(payload.jti),
    sessionId: str(payload.sid),
    expiresAt: (payload.exp as number) * 1000,
    claims: payload,
  };
}
