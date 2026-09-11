/**
 * Single source of truth for roles and permissions.
 * Imported by the API guards (`apps/api`) and the web UI (`apps/web`) so they
 * can never disagree. See docs/RBAC.md.
 */

export const ROLES = ['SUPER_ADMIN', 'PROJECT_MANAGER', 'ENGINEER', 'CUSTOMER'] as const;
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
  'user:delete', // hard-delete an account - SUPER_ADMIN only
  'user:mfa:reset',
  'discovery:read',
  'discovery:write',
  'discovery:review', // engineer/admin: accept or reopen a submitted discovery
  'discovery:sites:manage', // add / edit / delete sites - admin & engineer only
  'build:read',
  'build:write',
  'deployment:read',
  'deployment:connect',
  'deployment:dryrun',
  'deployment:execute',
  'handover:read',
  'handover:generate',
  'files:read', // browse generated/stored files for a tenant - all 4 roles
  'audit:read:tenant',
  'audit:read:platform',
  'feature:read', // view the feature-request board
  'feature:create', // submit a feature request
  'feature:manage', // move status, edit labels, delete - SUPER_ADMIN only
  'tenantdiscovery:read', // view the live-tenant Discovery inventory - admin & engineer only
  'tenantdiscovery:run', // connect to the customer tenant and run a discovery - admin & engineer only
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each role may do. For ENGINEER and CUSTOMER these permissions only apply
 * inside a tenant the user is a member of; `TenantGuard` in the API enforces the
 * membership check, this matrix answers "given they are in the tenant, can they?".
 */
export const PERMISSION_MATRIX: Record<Role, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set<Permission>(PERMISSIONS), // everything
  // Delivery lead for their assigned customers. Coordinates the project:
  // manages members/users, adds sites, runs & reviews discovery, produces the
  // handover. Does NOT do the technical build or run live deployments.
  PROJECT_MANAGER: new Set<Permission>([
    'tenant:read',
    'tenant:member:manage', // add CUSTOMER users only - enforced in service
    'user:create', // CUSTOMER users only, in their own customers - enforced in service
    'user:read', // list is scoped to their customers' users - enforced in service
    'discovery:read',
    'discovery:write',
    'discovery:review',
    'discovery:sites:manage',
    // NB: no build:* or deployment:* - Design & Build and Deployment are
    // engineer/admin-only and are hidden from the PM's left nav.
    'handover:read',
    'handover:generate',
    'files:read',
    'audit:read:tenant',
    'feature:read',
    'feature:create',
  ]),
  ENGINEER: new Set<Permission>([
    'tenant:read',
    'tenant:member:manage', // add CUSTOMER users only - enforced in service
    'user:create', // CUSTOMER users only, in their own customers - enforced in service
    'user:read', // list is scoped to their customers' users - enforced in service
    'discovery:read',
    'discovery:write',
    'discovery:review',
    'discovery:sites:manage',
    'build:read',
    'build:write',
    'deployment:read',
    'deployment:connect',
    'deployment:dryrun',
    'deployment:execute',
    'handover:read',
    'handover:generate',
    'files:read',
    'audit:read:tenant',
    'feature:read',
    'feature:create',
    // Discovery (live tenant inventory) - engineer/admin only; PMs and
    // customers never connect to the customer's Microsoft tenant.
    'tenantdiscovery:read',
    'tenantdiscovery:run',
  ]),
  CUSTOMER: new Set<Permission>([
    'tenant:read',
    'discovery:read',
    'discovery:write',
    // NB: no build:* or deployment:* - those areas are engineer/admin-only and
    // are hidden from the customer's left nav.
    'handover:read',
    'files:read',
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

/**
 * A CUSTOMER membership can be limited to specific sites (a "site contact") via
 * `tenant_memberships.site_ids` (empty = the whole customer). Site scoping never
 * narrows SUPER_ADMIN, PROJECT_MANAGER or ENGINEER - they always see the whole
 * customer. Sites are added/edited from the Sites admin page by SUPER_ADMIN,
 * PROJECT_MANAGER or ENGINEER (`discovery:sites:manage`). Enforced by
 * `TenantGuard` and the Data Collection services. See docs/RBAC.md.
 */
export function siteScopeApplies(role: Role): boolean {
  return role === 'CUSTOMER';
}
