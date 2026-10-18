import { isRole, roleRank, type Role } from '@tvmf/shared';

export interface RoleSource {
  kind: 'hub' | 'oidc';
  default_role: Role;
  role_claim: string | null;
  role_map: Record<string, Role>;
}

/** A claim by name, or by a dotted path such as `realm_access.roles` (Keycloak). */
function claimValue(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  let cur: unknown = claims;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * What the provider says this person should be, before the ceiling is applied (docs/SSO.md 4.3).
 * - The hub: its `vx_role` claim.
 * - Another provider: the `role_claim` it is set up with, each value looked up in `role_map`; if several match the most powerful wins.
 * - Nothing usable: the provider's `default_role` (least privilege unless an administrator chose otherwise).
 */
export function requestedRole(provider: RoleSource, claims: Record<string, unknown>): { role: Role; fromProvider: boolean } {
  if (provider.kind === 'hub') {
    return isRole(claims.vx_role) ? { role: claims.vx_role, fromProvider: true } : { role: provider.default_role, fromProvider: false };
  }
  if (provider.role_claim) {
    const raw = claimValue(claims, provider.role_claim);
    const values = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string');
    const mapped = values.map((v) => provider.role_map[v]).filter((r): r is Role => isRole(r));
    if (mapped.length > 0) return { role: mapped.reduce((a, b) => (roleRank(b) > roleRank(a) ? b : a)), fromProvider: true };
  }
  return { role: provider.default_role, fromProvider: false };
}
