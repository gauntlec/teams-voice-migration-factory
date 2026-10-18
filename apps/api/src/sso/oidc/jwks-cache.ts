import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { OidcError } from './oidc-error';

interface Entry {
  jwks: JSONWebKeySet;
  fetchedAt: number;
}

export interface JwksCacheOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** After a fetch, how long to wait before fetching again because of an unknown key id. Stops a flood of bad tokens becoming a flood of requests. */
  refreshCooldownMs?: number;
  /** A provider's key set is refetched at least this often even when every key id is known (keys can be withdrawn). */
  maxAgeMs?: number;
}

/**
 * A provider's signing keys (its JWKS), kept in memory. A key id that is not in the cache triggers one refetch (providers rotate keys),
 * at most once per cooldown; keys are only ever taken from the JWKS address the provider's discovery document names.
 */
export class JwksCache {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cooldown: number;
  private readonly maxAge: number;

  constructor(opts: JwksCacheOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.cooldown = opts.refreshCooldownMs ?? 10_000;
    this.maxAge = opts.maxAgeMs ?? 6 * 60 * 60_000;
  }

  forget(jwksUri?: string): void {
    if (jwksUri) this.entries.delete(jwksUri);
    else this.entries.clear();
  }

  private async fetchKeys(jwksUri: string): Promise<Entry> {
    let res: Response;
    try {
      res = await this.fetchFn(jwksUri, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new OidcError('jwks_unavailable', 'could not reach the key set');
    }
    if (!res.ok) throw new OidcError('jwks_unavailable', `status ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new OidcError('jwks_unavailable', 'not JSON');
    }
    const keys = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(keys) || keys.length === 0) throw new OidcError('jwks_unavailable', 'no keys');
    const entry = { jwks: { keys } as JSONWebKeySet, fetchedAt: this.now() };
    this.entries.set(jwksUri, entry);
    return entry;
  }

  /** A key getter for `jwtVerify`, backed by the cache, that refetches once when it meets a key id it does not know. */
  keyGetter(jwksUri: string): JWTVerifyGetKey {
    return async (header, token) => {
      let entry = this.entries.get(jwksUri);
      if (!entry || this.now() - entry.fetchedAt > this.maxAge) entry = await this.fetchKeys(jwksUri);
      try {
        return await createLocalJWKSet(entry.jwks)(header, token);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'ERR_JWKS_NO_MATCHING_KEY') throw err;
        if (this.now() - entry.fetchedAt < this.cooldown) throw new OidcError('unknown_key', 'key id not in the key set');
        entry = await this.fetchKeys(jwksUri);
        try {
          return await createLocalJWKSet(entry.jwks)(header, token);
        } catch (err2) {
          if ((err2 as { code?: string }).code === 'ERR_JWKS_NO_MATCHING_KEY') throw new OidcError('unknown_key', 'key id not in the key set');
          throw err2;
        }
      }
    };
  }
}
