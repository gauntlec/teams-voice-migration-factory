/**
 * Best-effort site inference for objects discovered by the live-tenant
 * Discovery scan (`tenant_objects`/`tenant_users`), which carry no site
 * attribution of their own. Callers should try a phone-number match
 * first (higher confidence - the number was already explicitly assigned
 * to that site's number range) and fall back to this naming-convention
 * match second.
 */

/** Splits on anything that isn't part of a `sitecode` (see `sitecodeSchema`). */
const NAME_TOKEN_RE = /[^A-Za-z0-9._-]+/;

/**
 * Looks for a token in `name` that case-insensitively matches one of
 * `sitecodes`. Confirmed live: `AA-UK-LUT-01-01-Reception` tokenizes to
 * `[AA, UK, LUT, 01, 01, Reception]`, matching a site whose sitecode is
 * `LUT`.
 */
export function matchSitecodeFromName(name: string, sitecodes: string[]): string | null {
  if (!name || !sitecodes.length) return null;
  const byLower = new Map(sitecodes.map((c) => [c.toLowerCase(), c]));
  for (const token of name.split(NAME_TOKEN_RE)) {
    const hit = byLower.get(token.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
