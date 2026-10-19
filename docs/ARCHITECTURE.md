# Architecture

## Purpose

Teams Voice Migration Factory (TVMF) replaces the four manual stages of a
Microsoft Teams voice migration with role-scoped web views:

| Stage | Replaces | Primary role |
|-------|----------|--------------|
| **Data Collection** | Discovery workbook filled in by the customer | Customer |
| **Design & Build** | `ATTC MS Teams Build 5.x.xlsx` build sheet | Engineer |
| **Deployment & Audit** | `Teams-Migration-Build-*.ps1` run against the tenant | Engineer |
| **Service Handover** | `Service Hand-Over Pack V1.x.docx` | Engineer (customer consumes) |

## Recommended stack (chosen for an AI-maintained codebase, no in-house coders)

One language end to end (TypeScript) so an AI assistant reasons about the whole
system at once, all mainstream libraries with large training corpora, and the
PowerShell runtime isolated in its own container so the rest of the system never
depends on it.

| Concern | Choice | Why |
|---------|--------|-----|
| Frontend | React + Vite + **Fluent UI v9** (`@fluentui/react-components`) | Same component library and design language as the Teams Admin Center |
| API | **NestJS** (TypeScript) | Opinionated, heavily documented structure; guards/modules map cleanly to RBAC |
| DB access | **Kysely** + `pg` | Type-safe SQL, no hidden magic, easy for AI to read and change |
| Migrations | Plain **`.sql` files** + tiny runner | Fully legible; no ORM migration DSL to learn |
| Job queue | **BullMQ** + Redis | Decouples the API from long-running tenant deployments and from sending email (`deployments` + `mail` queues) |
| PowerShell execution | **`apps/worker`** container `FROM mcr.microsoft.com/powershell` + Node | `MicrosoftTeams` module cmdlets have no Graph equivalent; kept off the API |
| Auth | Local accounts (Argon2id, mandatory TOTP) always available; optional single sign-on through OpenID Connect (the Voxshift Hub, or the customer's own provider such as Entra ID); JWT access + rotating refresh cookie | Local sign-in never depends on an external provider, so a provider outage cannot lock everyone out; SSO is off until an administrator switches it on (see [SSO.md](SSO.md)) |
| Packaging | Docker Compose (single host) | One command to stand up; migrate later to k8s if needed |

## Services

```
                    ┌────────────┐
   browser ───────▶ │  web (nginx)│  static React build, proxies /api
                    └─────┬──────┘
                          │ https
                    ┌─────▼──────┐        ┌───────────┐
                    │    api     │──────▶ │  postgres │  platform schema +
                    │  (NestJS)  │        │           │  one schema per tenant
                    │            │──────▶ │   redis   │  BullMQ queues
                    └─────┬──────┘        └─────┬─────┘
                          │ enqueue job         │ consume
                    ┌─────▼───────────────────────▼─────┐
                    │             worker                │
                    │  Node + pwsh + MicrosoftTeams mod │
                    │  device-code sign-in (live)       │
                    │  runs cmdlets, streams audit rows │
                    │  'mail' queue: renders + SMTP-sends│
                    └───────────────────────────────────┘
```

Email: the API writes a `platform.email_messages` row and enqueues a `mail` job;
the worker renders a branded template and sends it via SMTP. See
[`EMAIL.md`](EMAIL.md).

## Multi-tenancy

- **Schema-per-tenant** in one PostgreSQL instance.
- `platform` schema holds cross-tenant tables: `tenants`, `users`,
  `tenant_memberships`, `auth_sessions`, `totp_secrets`, `invitations`,
  `platform_audit_log`.
- Each customer gets a schema `tenant_<shortid>` created from
  `packages/db/migrations/tenant/*.sql` at the moment a super admin creates the
  customer. It holds every piece of that customer's migration data plus its own
  `audit_log`.
- Every tenant-scoped API request resolves exactly one target schema from
  `(authenticated user, X-Tenant-Id header)` and all queries for that request go
  through `db.withSchema(schema)`. There is no code path that queries a tenant
  table without an explicit schema. See `docs/SECURITY.md`.

## Customer tenant credentials — never stored

1. Engineer opens **Deployment** for a customer and clicks *Connect to tenant*.
2. API enqueues a `connection.start` job; the worker begins an Entra
   **device-code** flow and returns the `user_code` + verification URL.
3. Engineer completes sign-in in their own browser against the customer tenant.
4. The resulting access/refresh tokens live **only in worker process memory**
   for the life of the connection (idle timeout, default 240 min, `TEAMS_SESSION_TTL_MINUTES`) and are wiped on
   completion, timeout, or worker restart. They are never written to Postgres,
   Redis, or logs.
5. Every cmdlet the worker runs is written to the tenant's `deployment_changes`
   table: operator, correlation id, cmdlet, parameters (secrets redacted),
   target object, before/after snapshot, result, timestamp.

## Modules (API) / Views (web)

| Module | API prefix | Notes |
|--------|-----------|-------|
| auth | `/auth` | login, TOTP enrol/verify, refresh, logout; `/auth/providers`, `/auth/oidc/login`, `/auth/oidc/callback` (single sign-on) |
| sso | `/sso` | Super Admin: providers, role ceilings, test sign-in, linking people to provider identities, Voxshift staff access requests (`/sso/access`: list, approve, deny, end) ([SSO.md](SSO.md)); `/auth/staff-access/status` and `/continue` (public, cookie-bound) serve the waiting page |
| users | `/users` | super admin: manage staff + customer users |
| tenants | `/tenants` | super admin: create customer (provisions schema), manage memberships |
| data-collection | `/t/:tenantId/discovery` | discovery forms; customer writeable |
| build | `/t/:tenantId/build` | user/CAP/AA/CQ/group design grids + validation |
| deployment | `/t/:tenantId/deployments` | connect, dry-run, execute, audit stream |
| handover | `/t/:tenantId/handover` | generate the handover pack from final state |
| audit | `/t/:tenantId/audit` + `/audit` | read-only audit views |
| progress | `/t/:tenantId/progress` | home-page dashboard: each site's migration stage and blockers, derived from the other modules' data. See `docs/PROGRESS.md` |
| feature-requests | `/feature-requests` | staff-only enhancement board (kanban); SUPER_ADMIN moves cards, generates a "prompt for Claude" per card |
| tenant-discovery | `/t/:tenantId/tenant-discovery` | **Discovery**: admin/engineer connects to the customer's live Teams tenant (device code, PowerShell in the worker) and snapshots users, licences, numbers and every voice policy; links to Data Collection. See `docs/DISCOVERY.md` |

This scaffold ships the **auth / users / tenants / RBAC / tenancy** layer working
end to end; the four migration modules are present as guarded stubs with the data
model in place, to be filled in next.

## Web conventions

- **Tables — always use `components/DataTable.tsx`, never Fluent's `<Table>` directly.**
  Fluent v9 tables default to `table-layout: fixed` + `width: 100%`, so on a
  narrow window every column collapses to an equal sliver and cell text spills
  across the column edge. `DataTable` renders the scroll wrapper + a `<Table>`
  with `table-layout: auto`, a `minWidth` floor, and per-cell
  `nowrap / overflow:hidden / ellipsis`, so the box scrolls sideways instead of
  columns overlapping. Put `<TableHeader>` / `<TableBody>` inside as usual; pass
  `minWidth` (~130px per column). For a cell that must wrap, put its content in
  an inner `<div style={{ whiteSpace: 'pre-wrap' }}>`. The shared
  `records.tsx` `CrudSection` / `PagedSection` already build on it.
- Griffel `makeStyles` + `className` for styling — inline `style` on Fluent
  slot components (`Table`, `TableCell`, …) is dropped and won't apply.

## Operations: releasing safely

A release (push `main` → images build → **Update** in Dockge) restarts the
worker. Customer-tenant sessions live only in the worker's memory (pwsh
children - nothing is stored), so the worker's startup sweep
(`expireOrphanedWork` in `apps/worker/src/main.ts`) marks every
pending/active `connections` row `expired` and fails every queued/running
`tenant_discovery_runs` and `deployments` row. Engineers then have to sign in
to their customer tenants again (device code) and restart their runs.

**Before every release:**

1. **Administration → Observability → Release check** (`/admin/release-check`,
   SUPER_ADMIN, `platform:operate`; `GET /api/platform/release-check`). It lists,
   across every customer schema, exactly what the sweep would end: live
   sign-ins (with the engineer who owns each), queued/running discovery runs
   (including Design & Build Validate checks) and deployment runs (live ones
   flagged). **"Safe to release"** = nothing in progress. Built in
   `apps/api/src/platform-ops/release-check.ts`; wording in
   `summarizeReleaseCheck` (`packages/shared/src/release-safety.ts`).
2. If anything is in progress, ask the people listed, or set a **maintenance
   notice** on the same page: a message + a time ("Update at 18:00 - live
   tenant sessions will end"). Stored in `platform.maintenance_notice` (one
   row); `PUT`/`DELETE /api/platform/maintenance`, audited as
   `platform.maintenance_notice_set` / `_cleared`.
   - Every signed-in staff member sees it as a banner (AppShell polls
     `GET /api/platform/maintenance` every minute; customers get `null`).
   - In its **final 10 minutes** (`MAINTENANCE_FREEZE_MINUTES`) - and after the
     time until it is cleared - the API refuses to start a new deployment run
     (What-If or live), discovery run or customer-tenant sign-in, with a
     clear message (`assertNoMaintenanceFreeze`,
     `apps/api/src/platform-ops/maintenance.ts`). A Design & Build Validate
     check quietly falls back to its database-only result. Work already running
     is not touched.
   - A notice nobody cleared lapses 30 minutes after its time
     (`MAINTENANCE_LAPSE_MINUTES`) so a forgotten one can't block work forever.
3. Re-run the check; release when it says **Safe to release** (or when the
   people listed have agreed). Clear the notice afterwards.

**Testing on a test customer.** Mark a customer as a **test customer**
(Customers page, SUPER_ADMIN; `platform.tenants.sandbox`) and none of its
emails reach real recipients - each goes to whoever triggered it, subject
prefixed `[TEST - would have gone to x@y]`. The switcher shows a
**Test customer** badge. Details in [`EMAIL.md`](EMAIL.md#test-customers).

## Testing

Two suites, both run by CI's `verify` job before any image is built (a red
run means nothing ships):

| Command | What it covers | Where |
| --- | --- | --- |
| `npm run test` | Pure unit tests (no database) - cmdlet planning, SR rules, mappers | `packages/shared/src/*.test.ts` |
| `npm run test:db` | Database-backed tests: the real API/worker services against real Postgres with every migration applied | `tests/db/src/**/*.db.test.ts` |

Run both after `npm run build:packages` (the apps import `@tvmf/shared` and
`@tvmf/db` from their built `dist/`):

```bash
npm install
npm run build:packages
npm run test
npm run test:db
```

**How `test:db` works.** `tests/db` is its own workspace (`@tvmf/db-tests`),
so its `embedded-postgres` dev dependency never reaches a Docker image (the
Dockerfiles only copy `packages/` and `apps/`).

- `tests/db/src/global-setup.ts` starts **one** Postgres 16 for the whole run
  (`embedded-postgres` - no Docker or local install needed, same major as
  production), on a free port in a temp folder, and applies the platform
  migrations. It's deleted when the run ends. To use an existing throwaway
  database instead, set `TEST_DATABASE_URL`.
- Each test file calls `useDb()` and `seedCustomer()` (`tests/db/src/helpers.ts`),
  which provisions a **fresh tenant schema** with every tenant migration, so
  files run in parallel without seeing each other's rows. `seedUser`,
  `seedSite`, `seedNumbers` and `seedConnection` add the usual fixtures.
- Services are constructed directly (`new BuildService(db, new AuditService(db), ...)`)
  from the TypeScript source - no Nest app, no build of `apps/*` needed.
  Dependencies a test shouldn't touch are `unused('name')` (throws if called);
  queues and mail are small fakes. `tests/db/src/setup.ts` swaps out the
  API's `queue.module` so importing a service never opens a Redis connection.
- The discovery worker is driven by calling `handleTenantDiscoveryRun` with a
  fake job and a fake PowerShell session (`alive` / `graphAlive` / `query`).

**When to add one.** Any bug that was about data - a row left behind, a
number not freed, history not written, a run stuck in flight - gets a
`*.db.test.ts` that fails without the fix. Check it does: undo the fix
locally, watch the test fail, put the fix back.
