/**
 * Best-effort site inference for objects discovered by the live-tenant
 * Discovery scan (`tenant_objects`/`tenant_users`), which carry no site
 * attribution of their own. Callers should try a phone-number match
 * first (higher confidence - the number was already explicitly assigned
 * to that site's number range) and fall back to this naming-convention
 * match second.
 */

/**
 * Looks for a `sitecode` that appears as a case-insensitive substring of
 * `name`, returning the longest match (a site's `sitecode` may itself be
 * dash-joined - e.g. `LUT-01-01` - so it can't be found by splitting the
 * name into tokens on the same delimiters `sitecodeSchema` allows inside a
 * sitecode; those delimiters never split it back out). Confirmed live:
 * `AA-UK-LUT-01-01-Reception` contains sitecode `LUT-01-01` as a literal
 * substring, not as a standalone token.
 */
export function matchSitecodeFromName(name: string, sitecodes: string[]): string | null {
  if (!name || !sitecodes.length) return null;
  const lowerName = name.toLowerCase();
  let best: string | null = null;
  for (const code of sitecodes) {
    if (code && lowerName.includes(code.toLowerCase())) {
      if (!best || code.length > best.length) best = code;
    }
  }
  return best;
}
