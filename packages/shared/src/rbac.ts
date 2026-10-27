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
  'msp:create', // manage Managed Service Providers (branding for staff) - SUPER_ADMIN only
  'msp:read',
  'msp:update',
  'msp:delete',
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
  'handover:issue', // lock a draft pack as final
  'files:read', // browse generated/stored files for a tenant - all 4 roles
  'audit:read:tenant',
  'audit:read:platform',
  'feature:read', // view the feature-request board
  'feature:create', // submit a feature request
  'feature:manage', // move status, edit labels, delete - SUPER_ADMIN only
  'sr:read', // Managed Services: see this customer's service requests
  'sr:create', // raise a service request, and comment on one
  'sr:manage', // action requests: plan, build, deploy, cancel, assign, internal notes - engineers and admins
  'sr:msp', // MSP service-request admin: one queue across every customer of your MSP
  'inc:read', // Incidents: see this customer's incidents
  'inc:create', // raise an incident, comment, confirm fixed or reopen your own
  'inc:manage', // triage: acknowledge, assign, change status and priority, internal notes, link - engineers and admins
  'inc:msp', // MSP incident queue: one queue across every customer of your MSP
  'bug:read', // view the bug-report board
  'bug:create', // log a bug report
  'bug:manage', // move status, edit labels, delete - SUPER_ADMIN only
  'tenantdiscovery:read', // view the live-tenant Discovery inventory - admin & engineer only
  'tenantdiscovery:run', // connect to the customer tenant and run a discovery - admin & engineer only
  'monitoring:read', // Monitoring > Devices: the live status screen - admin, project manager, engineer and customer
  'monitoring:manage', // Monitoring: add, change and remove devices, the watch list, set monitoring up, email alerts - admin & engineer only
  'intake:manage', // monitoring alert sources and the inbound mailbox settings: create, tokens, per-customer switches - SUPER_ADMIN only
  'agent:manage', // AI agents: create, tokens, per-customer autonomy, webhooks, kill switches - SUPER_ADMIN only
  'platform:operate', // release check + maintenance notice - SUPER_ADMIN only
  'sso:manage', // single sign-on: providers, role ceilings, linking people to provider identities - SUPER_ADMIN only
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
    'sr:read',
    'sr:create',
    'sr:msp',
    'inc:read',
    'inc:create',
    'inc:msp',
    'handover:generate',
    'handover:issue', // lock a draft pack as final
    'files:read',
    'audit:read:tenant',
    'feature:read',
    'feature:create',
    'bug:read',
    'bug:create',
    'monitoring:read', // the status screen only: project managers do not add devices or change alerts
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
    'sr:read',
    'sr:create',
    'sr:msp',
    'sr:manage',
    'inc:read',
    'inc:create',
    'inc:msp',
    'inc:manage',
    'handover:generate',
    'handover:issue', // lock a draft pack as final
    'files:read',
    'audit:read:tenant',
    'feature:read',
    'feature:create',
    'bug:read',
    'bug:create',
    // Discovery (live tenant inventory) - engineer/admin only; PMs and
    // customers never connect to the customer's Microsoft tenant.
    'tenantdiscovery:read',
    'tenantdiscovery:run',
    'monitoring:read',
    'monitoring:manage',
  ]),
  CUSTOMER: new Set<Permission>([
    'tenant:read',
    'discovery:read',
    'discovery:write',
    // NB: no build:* or deployment:* - those areas are engineer/admin-only and
    // are hidden from the customer's left nav.
    'handover:read',
    'sr:read',
    'sr:create',
    'inc:read',
    'inc:create',
    'files:read',
    'audit:read:tenant',
    'monitoring:read', // the status screen, for their own sites if scoped
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
