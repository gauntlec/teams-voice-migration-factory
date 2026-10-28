# Roles & access control

Four roles, plus a per-membership **site scope** for large customers. The
single source of truth is `packages/shared/src/rbac.ts` (`PERMISSION_MATRIX`);
the API guard and the web UI both import it so they can never drift.

## Roles

### `SUPER_ADMIN`
Complete control of the whole platform.
- Manage tenants (create → provisions a schema, rename, archive). **Delete a customer and all of its data for good** (permission `tenant:delete`,
  Super Admin only: needs the typed name and a fresh authenticator code, see [SECURITY.md](SECURITY.md#deleting-a-customer)).
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
assigned customer, full access to every module (Site Data, Design & Build,
Deployment, Handover, Audit), including adding/editing **sites** (Sites admin
page). Can switch between their assigned customers (`X-Tenant-Id`). An engineer
can **create** customer users in a customer they are assigned to and grant them
whole-customer or site-scoped access. Cannot create tenants, cannot manage staff
accounts, cannot see tenants they are not assigned to.

### `CUSTOMER`
Belongs to exactly **one** tenant. Site Data: read + write (this is their
job — fill in discovery). Service Handover: read-only. Audit: read-only, own
tenant only. **Design & Build and Deployment are not shown**; **cannot add or
edit sites** (engineer/admin only). No access to users, tenants, or any other
customer.

### Managed Services (incidents)
Incident management uses the same Managed Services switch. `inc:read` and
`inc:create` let SUPER_ADMIN, PROJECT_MANAGER, ENGINEER and CUSTOMER see and raise
incidents, comment, and (for the reporter or a watcher) confirm a fix or say it is
still broken; `inc:manage` (SUPER_ADMIN and ENGINEER) acknowledges, assigns, moves,
changes priority, adds internal notes and links items; `inc:msp` (SUPER_ADMIN,
ENGINEER, PROJECT_MANAGER) is the MSP incident queue (a later chunk). A site contact
only sees and raises incidents for their own sites. Targets and the priority matrix
are changed by Super Admins only. See [INCIDENT-MANAGEMENT.md](INCIDENT-MANAGEMENT.md).

### Managed Services (service requests)
When Managed Services is switched on for a customer, `sr:read` and `sr:create`
let SUPER_ADMIN, PROJECT_MANAGER, ENGINEER and CUSTOMER see and raise service
requests; `sr:manage` (SUPER_ADMIN and ENGINEER) lets them action requests
(plan, build, deploy, cancel, assign, internal notes) and move sites between
project and operations mode; `sr:msp` (SUPER_ADMIN, ENGINEER, PROJECT_MANAGER)
opens the MSP service-request admin queue across an MSP's customers. A site contact only sees
and raises requests for their own sites. See [SERVICE-REQUESTS.md](SERVICE-REQUESTS.md).

#### Site-scoped customer ("site contact")
A `CUSTOMER` membership can carry `tenant_memberships.site_ids` (a list of
`discovery_sites.id`). Empty = the whole customer. Non-empty = the user is a
**site contact**: they see and edit only Site Data rows tied to those
sites — number ranges + inventory, users, CAPs, resource accounts, network
subnets and call-flow notes. Site records and each site's **Overview**
(`discovery_sites.overview` — the 7 overview fields + assigned engineers/PMs) are
**read-only** for every `CUSTOMER`; they are edited by SUPER_ADMIN /
PROJECT_MANAGER / ENGINEER (`discovery:sites:manage`). Outbound calling policies
and submitting the discovery for review also stay with the project manager /
engineer. `TenantGuard` resolves the scope onto `req.tenant.siteScope`; the Data
Collection services filter every read and check every write against it.

## Roles and single sign-on

People can also sign in through the Voxshift Hub or the customer's own OpenID Connect provider (Entra ID and so on): see [SSO.md](SSO.md) and
[SSO-ADMIN-GUIDE.md](SSO-ADMIN-GUIDE.md). The four roles are the same; only where the role comes from changes.

- **The provider proposes, the installation caps.** The role a person gets is the lower of what the provider asks for (the hub's per-installation grant, or the
  customer's own provider's role claim and map, else its default role, Customer) and the **ceiling** an administrator of the installation sets for that provider.
  Order: `SUPER_ADMIN` > `PROJECT_MANAGER` > `ENGINEER` > `CUSTOMER`. Hub staff default ceiling: `SUPER_ADMIN`; hub accounts of the customer's own people: `ENGINEER`;
  a customer's own provider: `PROJECT_MANAGER`. All editable by a Super Admin (`sso:manage`).
- **The role is provider-managed.** It is set at every provider sign-in, so a role changed by hand under Users does not survive that person's next provider sign-in.
- **Customer memberships are not provided by the provider.** A person created by a provider sign-in has the role but is assigned to no customers (except a Super Admin, who sees all);
  an administrator adds them under Users, exactly as for a local account. A `CUSTOMER` created this way also needs a site scope or whole-customer membership.
- **Break-glass.** A Super Admin created locally keeps password + authenticator sign-in whatever a provider says and cannot be linked to a provider.
- Only a Super Admin can add or change providers, ceilings and links (`sso:manage`).
- **The role does not decide who approves Voxshift staff.** When an installation requires approval for hub staff sign-ins ([SSO.md](SSO.md) 4.3a), approving, denying and ending a window are `sso:manage` actions, and in addition the Super Admin must **not** have signed in through the Voxshift Hub (so a hub staff Super Admin cannot approve themselves or loosen the rule). No new role or permission was added.
- **Removal at the hub.** A person removed from the installation at the hub is signed out within about a minute; an account that exists only through the hub is switched off, so it no longer appears as a live Super Admin under Users ([SSO.md](SSO.md) 4.7).

## Where sites are managed

Site records (sitecode, address, map coordinates) are created and edited on the
**Sites admin page** (`/admin/sites`, `discovery:sites:manage` → SUPER_ADMIN,
PROJECT_MANAGER, ENGINEER). The Site Data module shows sites read-only
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
files:read
audit:read:tenant   audit:read:platform
feature:read  feature:create  feature:manage
bug:read  bug:create  bug:manage
tenantdiscovery:read  tenantdiscovery:run
monitoring:read  monitoring:manage
platform:operate
sso:manage
```

## Matrix (✓ = allowed)

| Permission | SUPER_ADMIN | PROJECT_MANAGER (assigned) | ENGINEER (assigned) | CUSTOMER (own tenant) |
|---|:--:|:--:|:--:|:--:|
| tenant:create / archive | ✓ | | | |
| **tenant:delete** (delete a customer and all its data, for good; also needs a fresh authenticator code) | ✓ | | | |
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
| files:read (browse generated/stored files) | ✓ | ✓ | ✓ | ✓ |
| audit:read:tenant | ✓ | ✓ | ✓ | ✓ |
| audit:read:platform | ✓ | | | |
| feature:read / feature:create | ✓ | ✓ | ✓ | |
| feature:manage (move / edit / delete cards) | ✓ | | | |
| bug:read / bug:create | ✓ | ✓ | ✓ | |
| bug:manage (move / edit / delete cards) | ✓ | | | |
| inc:read / inc:create (Incidents: see, raise, comment) | ✓ | ✓ | ✓ | ✓ (own sites if scoped) |
| inc:manage (triage, assign, move, priority, internal notes, run diagnostic checks, ask an assistant, decide assistants' proposals) | ✓ | | ✓ | |
| inc:msp (MSP incident queue) | ✓ | ✓ | ✓ | |
| intake:manage (alert sources for incident intake, demo incidents) | ✓ | | | |
| agent:manage (Administration -> Assistants: create agents, tokens, customer policies, webhooks, kill switches) | ✓ | | | |
| tenantdiscovery:read / run (Discovery: connect to the customer's live Teams tenant) | ✓ | | ✓ | |
| monitoring:read (Monitoring > Devices: the live status screen; customers see only their own sites if scoped) | ✓ | ✓ | ✓ | ✓ |
| monitoring:manage (Monitoring > Watch list and Alerts: add / change / remove devices, set monitoring up, email alert settings) | ✓ | | ✓ | |
| platform:operate (Release check page, set/clear the maintenance notice) | ✓ | | | |
| sso:manage (Platform settings > Single sign-on: providers, role ceilings, linking people to provider identities, approving Voxshift staff access if the person did not sign in through the hub; see [SSO.md](SSO.md)) | ✓ | | | |

## Enforcement

1. `JwtAuthGuard` — valid, unexpired access token; loads the user.
2. `TenantGuard` — for `/t/:tenantId/*` routes: confirms the user has a
   membership row for that tenant (super admin bypasses). Puts the resolved
   schema and the membership's `siteScope` (null = whole customer) on the request.
3. `PermissionsGuard` — reads `@RequirePermission('build:write')` metadata and
   checks `can(role, permission)` from the shared matrix.
4. Site scope — the Site Data services (`data-collection.service.ts`,
   `data-collection.telephony.service.ts`) narrow every read to `req.tenant.siteScope`
   and reject any write to a row outside it (`site-scope.ts` helpers). Customer-wide
   actions (overview, calling policies, sites, submit) call `assertCustomerWide`.
5. Web mirrors the same checks with `useCan()` plus `me.tenants[].siteScoped` to
   hide/disable controls, but the API is the authority.
