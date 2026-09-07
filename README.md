# Teams Voice Migration Factory

Multi-tenant web platform that replaces the manual Microsoft Teams voice
migration workflow — **Data Collection → Design & Build → Deployment (audited) →
Service Handover** — styled to feel like the Microsoft Teams Admin Center.

> This repository is intended to be maintained with AI coding assistance. The
> `docs/` folder is the contract: read it before changing anything.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — services, stack, why
- [`docs/RBAC.md`](docs/RBAC.md) — the three roles and the permission matrix
- [`docs/SECURITY.md`](docs/SECURITY.md) — tenant isolation, no stored credentials, audit
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) — tables, mapped to the current workbook

## What this scaffold contains

Working now:

- Monorepo (`npm` workspaces): `apps/web`, `apps/api`, `apps/worker`,
  `packages/shared`, `packages/db`.
- `docker compose up --build` brings up Postgres, Redis, API, worker, web,
  Adminer.
- **Auth**: local accounts, Argon2id, mandatory TOTP, JWT access + rotating
  refresh cookie, session revocation.
- **RBAC**: `SUPER_ADMIN` / `ENGINEER` / `CUSTOMER`, one shared permission matrix
  used by both API guards and the web UI.
- **Multi-tenancy**: schema-per-tenant. Creating a customer provisions a schema
  from `packages/db/migrations/tenant/*.sql`. Every tenant request resolves one
  schema via `TenantGuard`.
- **Teams Admin Center-style shell**: Fluent UI v9, left rail, tenant switcher,
  the four module views present as role-gated pages.

Stubbed, with the data model and interfaces in place:

- The four migration modules' business logic (forms, validation grids, the
  deployment engine cmdlet mapping, the .docx generator).
- `apps/worker` ships `SimulatedTeamsExecutor`; `PwshTeamsExecutor` (real
  `MicrosoftTeams` module + device-code sign-in) is defined and ready to build.

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: set the *_SECRET / *_KEY values and BOOTSTRAP_ADMIN_* 
docker compose run --rm migrator                       # create the platform schema
docker compose up --build -d                           # start everything
docker compose exec api npm run seed --workspace @tvmf/db   # create the super admin
```

Then open:

- Web app: <http://localhost:5173>
- API health: <http://localhost:4000/health>
- Adminer (DB browser): <http://localhost:8080>

Sign in with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`, complete the
TOTP enrolment, then create a customer tenant and invite users.

## Local development (without Docker)

Requires Node 20–22 and a local Postgres + Redis.

```bash
npm install
export DATABASE_URL=postgres://localhost:5432/tvmf REDIS_URL=redis://localhost:6379
npm run migrate
npm run seed
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:5173
npm run dev:worker
```

## Repository layout

```
apps/
  web/      React + Vite + Fluent UI v9 (Teams Admin Center styling)
  api/      NestJS API — auth, RBAC, tenants, module endpoints
  worker/   Node + pwsh; consumes deployment jobs, runs MicrosoftTeams cmdlets
packages/
  shared/   role/permission matrix, domain value lists, shared DTO/zod schemas
  db/       Kysely types, .sql migrations (platform + tenant template), runner, seed
docs/       architecture / rbac / security / data-model
infra/      (reserved) k8s, CI
```
