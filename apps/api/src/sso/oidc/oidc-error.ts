/**
 * Why an OpenID Connect step failed. The `reason` is a short code for the audit log; it never contains a token, a code or a secret, and
 * the person signing in only ever sees a generic message (docs/SSO.md 4.2).
 */
export type OidcFailure =
  | 'discovery_failed'
  | 'issuer_mismatch'
  | 'insecure_endpoint'
  | 'token_endpoint_error'
  | 'no_id_token'
  | 'token_malformed'
  | 'token_alg_not_allowed'
  | 'token_signature'
  | 'token_issuer'
  | 'token_audience'
  | 'token_authorized_party'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'token_missing_claim'
  | 'token_nonce'
  | 'unknown_key'
  | 'jwks_unavailable'
  | 'mfa_not_proven';

export class OidcError extends Error {
  constructor(
    public readonly reason: OidcFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'OidcError';
  }
}
