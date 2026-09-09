# Roles & access control

Four roles, plus a per-membership **site scope** for large customers. The
single source of truth is `packages/shared/src/rbac.ts` (`PERMISSION_MATRIX`);
the API guard and the web UI both import it so they can never drift.

## Roles

### `SUPER_ADMIN`
Complete control of the whole platform.
- Manage tenants (create → provisions a schema, rename, archive, delete).
- Manage all users (create staff, assign roles, reset MFA, disable, delete).
  Delete is a hard delete (removes the account, its sessions, MFA and customer
  assignments); the API blocks deleting yourself or the last active super admin.
- Full read/write on every module of every tenant.
- Read the platform audit log and every tenant audit log.

### `PROJECT_MANAGER`
Delivery lead for their assigned customers (via `tenant_memberships`, always
whole-customer). Coordinates the project: manages members and creates CUSTOMER
users, adds/edits **sites** (Sites admin page), runs and **reviews** discovery,
and produces the handover pack. **Design & Build and Deployment are not shown** —
those are engineer/admin only. Cannot create tenants or manage staff accounts.

### `ENGINEER`
Delivery staff. Assigned to **one or more** customers via
`tenant_memberships` (always whole-customer — never site-scoped). Within an
assigned customer, full access to every module (Data Collection, Design & Build,
Deployment, Handover, Audit), including adding/editing **sites** (Sites admin
page). Can switch between their assigned customers (`X-Tenant-Id`). An engineer
can **create** customer users in a customer they are assigned to and grant them
whole-customer or site-scoped access. Cannot create tenants, cannot manage staff
accounts, cannot see tenants they are not assigned to.

### `CUSTOMER`
Belongs to exactly **one** tenant. Data Collection: read + write (this is their
job — fill in discovery). Service Handover: read-only. Audit: read-only, own
tenant only. **Design & Build and Deployment are not shown**; **cannot add or
edit sites** (engineer/admin only). No access to users, tenants, or any other
customer.

#### Site-scoped customer ("site contact")
A `CUSTOMER` membership can carry `tenant_memberships.site_ids` (a list of
`discovery_sites.id`). Empty = the whole customer. Non-empty = the user is a
**site contact**: they see and edit only Data Collection rows tied to those
sites — number ranges + inventory, users, CAPs, resource accounts, network
subnets and call-flow notes. Site records and each site's **Overview**
(`discovery_sites.overview` — the 7 overview fields + assigned engineers/PMs) are
**read-only** for every `CUSTOMER`; they are edited by SUPER_ADMIN /
PROJECT_MANAGER / ENGINEER (`discovery:sites:manage`). Outbound calling policies
and submitting the discovery for review also stay with the project manager /
engineer. `TenantGuard` resolves the scope onto `req.tenant.siteScope`; the Data
Collection services filter every read and check every write against it.

## Where sites are managed

Site records (sitecode, address, map coordinates) are created and edited on the
**Sites admin page** (`/admin/sites`, `discovery:sites:manage` → SUPER_ADMIN,
PROJECT_MANAGER, ENGINEER). The Data Collection module shows sites read-only
(map + list, "open site"). The API for site CRUD is unchanged
(`POST/PATCH/DELETE /t/:id/discovery/sites`).

## Permission keys

```
tenant:create  tenant:read  tenant:update  tenant:archive  tenant:delete
tenant:member:manage
user:create  user:read  user:update  user:disable  user:delete  user:mfa:reset
discovery:read  discovery:write  discovery:review  discovery:sites:manage
build:read     build:write
deployment:read  deployment:connect  deployment:dryrun  deployment:execute
handover:read  handover:generate
audit:read:tenant   audit:read:platform
feature:read  feature:create  feature:manage
tenantdiscovery:read  tenantdiscovery:run
```

## Matrix (✓ = allowed)

| Permission | SUPER_ADMIN | PROJECT_MANAGER (assigned) | ENGINEER (assigned) | CUSTOMER (own tenant) |
|---|:--:|:--:|:--:|:--:|
| tenant:create / delete / archive | ✓ | | | |
| tenant:read | ✓ (all) | ✓ (assigned) | ✓ (assigned) | ✓ (own) |
| tenant:update | ✓ | | | |
| tenant:member:manage | ✓ | ✓ (CUSTOMER only, own) | ✓ (CUSTOMER only, own) | |
| user:create / read | ✓ | ✓ (CUSTOMER only, own) | ✓ (CUSTOMER only, own) | |
| user:update / disable / mfa:reset | ✓ | | | |
| user:delete | ✓ (not self / last super admin) | | | |
| discovery:read / write | ✓ | ✓ | ✓ | ✓ (own sites if scoped) |
| discovery:review | ✓ | ✓ | ✓ | |
| discovery:sites:manage | ✓ | ✓ | ✓ | |
| build:read | ✓ | | ✓ | |
| build:write | ✓ | | ✓ | |
| deployment:read | ✓ | | ✓ | |
| deployment:connect / dryrun / execute | ✓ | | ✓ | |
| handover:read | ✓ | ✓ | ✓ | ✓ |
| handover:generate | ✓ | ✓ | ✓ | |
| audit:read:tenant | ✓ | ✓ | ✓ | ✓ |
| audit:read:platform | ✓ | | | |
| feature:read / feature:create | ✓ | ✓ | ✓ | |
| feature:manage (move / edit / delete cards) | ✓ | | | |
| tenantdiscovery:read / run (Discovery: connect to the customer's live Teams tenant) | ✓ | | ✓ | |

## Enforcement

1. `JwtAuthGuard` — valid, unexpired access token; loads the user.
2. `TenantGuard` — for `/t/:tenantId/*` routes: confirms the user has a
   membership row for that tenant (super admin bypasses). Puts the resolved
   schema and the membership's `siteScope` (null = whole customer) on the request.
3. `PermissionsGuard` — reads `@RequirePermission('build:write')` metadata and
   checks `can(role, permission)` from the shared matrix.
4. Site scope — the Data Collection services (`data-collection.service.ts`,
   `data-collection.telephony.service.ts`) narrow every read to `req.tenant.siteScope`
   and reject any write to a row outside it (`site-scope.ts` helpers). Customer-wide
   actions (overview, calling policies, sites, submit) call `assertCustomerWide`.
5. Web mirrors the same checks with `useCan()` plus `me.tenants[].siteScoped` to
   hide/disable controls, but the API is the authority.
