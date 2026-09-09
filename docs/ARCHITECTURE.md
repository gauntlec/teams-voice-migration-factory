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
| Auth | Local accounts, Argon2id, JWT access + rotating refresh cookie, mandatory TOTP | No external IdP dependency (per decision) |
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
   for the life of the connection (hard TTL, default 60 min) and are wiped on
   completion, timeout, or worker restart. They are never written to Postgres,
   Redis, or logs.
5. Every cmdlet the worker runs is written to the tenant's `deployment_changes`
   table: operator, correlation id, cmdlet, parameters (secrets redacted),
   target object, before/after snapshot, result, timestamp.

## Modules (API) / Views (web)

| Module | API prefix | Notes |
|--------|-----------|-------|
| auth | `/auth` | login, TOTP enrol/verify, refresh, logout |
| users | `/users` | super admin: manage staff + customer users |
| tenants | `/tenants` | super admin: create customer (provisions schema), manage memberships |
| data-collection | `/t/:tenantId/discovery` | discovery forms; customer writeable |
| build | `/t/:tenantId/build` | user/CAP/AA/CQ/group design grids + validation |
| deployment | `/t/:tenantId/deployments` | connect, dry-run, execute, audit stream |
| handover | `/t/:tenantId/handover` | generate the handover pack from final state |
| audit | `/t/:tenantId/audit` + `/audit` | read-only audit views |
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
