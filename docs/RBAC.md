# Roles & access control

Three roles. The single source of truth is
`packages/shared/src/rbac.ts` (`PERMISSION_MATRIX`); the API guard and the web
UI both import it so they can never drift.

## Roles

### `SUPER_ADMIN`
Complete control of the whole platform.
- Manage tenants (create → provisions a schema, rename, archive, delete).
- Manage all users (create staff, assign roles, reset MFA, disable).
- Full read/write on every module of every tenant.
- Read the platform audit log and every tenant audit log.

### `ENGINEER`
Delivery staff. Assigned to **one or more** customers via
`tenant_memberships`. Within an assigned customer, full access to every module
(Data Collection, Design & Build, Deployment, Handover, Audit). Can switch
between their assigned customers (`X-Tenant-Id`). An engineer can invite
**customer** users into a tenant they are assigned to. Cannot create tenants,
cannot manage staff accounts, cannot see tenants they are not assigned to.

### `CUSTOMER`
Belongs to exactly **one** tenant.
- Data Collection: read + write (this is their job — fill in discovery).
- Design & Build, Deployment, Handover: read-only (they can watch progress and
  download the handover pack).
- Audit: read-only, own tenant only.
- No access to users, tenants, or any other customer.

## Permission keys

```
tenant:create  tenant:read  tenant:update  tenant:archive  tenant:delete
tenant:member:manage
user:create  user:read  user:update  user:disable  user:mfa:reset
discovery:read  discovery:write
build:read     build:write
deployment:read  deployment:connect  deployment:dryrun  deployment:execute
handover:read  handover:generate
audit:read:tenant   audit:read:platform
```

## Matrix (✓ = allowed)

| Permission | SUPER_ADMIN | ENGINEER (assigned tenant) | CUSTOMER (own tenant) |
|---|:--:|:--:|:--:|
| tenant:create / delete / archive | ✓ | | |
| tenant:read | ✓ (all) | ✓ (assigned) | ✓ (own) |
| tenant:update | ✓ | | |
| tenant:member:manage | ✓ | ✓ (add CUSTOMER only) | |
| user:* | ✓ | | |
| discovery:read | ✓ | ✓ | ✓ |
| discovery:write | ✓ | ✓ | ✓ |
| build:read | ✓ | ✓ | ✓ |
| build:write | ✓ | ✓ | |
| deployment:read | ✓ | ✓ | ✓ |
| deployment:connect / dryrun / execute | ✓ | ✓ | |
| handover:read | ✓ | ✓ | ✓ |
| handover:generate | ✓ | ✓ | |
| audit:read:tenant | ✓ | ✓ | ✓ |
| audit:read:platform | ✓ | | |

## Enforcement

1. `JwtAuthGuard` — valid, unexpired access token; loads the user.
2. `TenantGuard` — for `/t/:tenantId/*` routes: confirms the user has a
   membership row for that tenant (super admin bypasses). Puts the resolved
   schema on the request.
3. `PermissionsGuard` — reads `@RequirePermission('build:write')` metadata and
   checks `can(role, permission)` from the shared matrix.
4. Web mirrors the same checks with `useCan()` to hide/disable controls, but the
   API is the authority.
