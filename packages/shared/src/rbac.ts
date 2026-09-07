/**
 * Single source of truth for roles and permissions.
 * Imported by the API guards (`apps/api`) and the web UI (`apps/web`) so they
 * can never disagree. See docs/RBAC.md.
 */

export const ROLES = ['SUPER_ADMIN', 'ENGINEER', 'CUSTOMER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'tenant:create',
  'tenant:read',
  'tenant:update',
  'tenant:archive',
  'tenant:delete',
  'tenant:member:manage',
  'user:create',
  'user:read',
  'user:update',
  'user:disable',
  'user:mfa:reset',
  'discovery:read',
  'discovery:write',
  'build:read',
  'build:write',
  'deployment:read',
  'deployment:connect',
  'deployment:dryrun',
  'deployment:execute',
  'handover:read',
  'handover:generate',
  'audit:read:tenant',
  'audit:read:platform',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each role may do. For ENGINEER and CUSTOMER these permissions only apply
 * inside a tenant the user is a member of; `TenantGuard` in the API enforces the
 * membership check, this matrix answers "given they are in the tenant, can they?".
 */
export const PERMISSION_MATRIX: Record<Role, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set<Permission>(PERMISSIONS), // everything
  ENGINEER: new Set<Permission>([
    'tenant:read',
    'tenant:member:manage', // add CUSTOMER users only - enforced in service
    'discovery:read',
    'discovery:write',
    'build:read',
    'build:write',
    'deployment:read',
    'deployment:connect',
    'deployment:dryrun',
    'deployment:execute',
    'handover:read',
    'handover:generate',
    'audit:read:tenant',
  ]),
  CUSTOMER: new Set<Permission>([
    'tenant:read',
    'discovery:read',
    'discovery:write',
    'build:read',
    'deployment:read',
    'handover:read',
    'audit:read:tenant',
  ]),
};

export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_MATRIX[role]?.has(permission) ?? false;
}

/** Roles that are never scoped to a single tenant. */
export const GLOBAL_ROLES: ReadonlySet<Role> = new Set<Role>(['SUPER_ADMIN']);

export function isGlobalRole(role: Role): boolean {
  return GLOBAL_ROLES.has(role);
}
