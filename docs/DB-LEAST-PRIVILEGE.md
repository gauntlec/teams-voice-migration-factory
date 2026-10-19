# Database least privilege (design, not built)

**Status: not built.** This records what it would take to make "the audit tables cannot be changed by the application" true at the
database, what it would and would not protect, and the risks. Today the application is the only control: see "Database access" in
[SECURITY.md](SECURITY.md). Written 2026-10-19 from the code.

## Today

- One Postgres account, `tvmf` (the image's `POSTGRES_USER`, a superuser), in `DATABASE_URL`. It owns every schema and table.
- The api container runs `migrate.js && seed.js && main.js` with that URL; the worker uses the same URL. The compose file passes the
  whole `.env` (`env_file: .env`), so a new variable in `.env` reaches both without a compose change.
- The only DDL the running application does is `provisionTenant()` (`apps/api/src/tenants/tenants.service.ts`, when a Super Admin
  creates a customer): `CREATE SCHEMA` plus the tenant migrations. Nothing in the api or worker drops a schema or table, and nothing
  updates or deletes `platform.platform_audit_log`, a tenant's `audit_log` or `deployment_changes` (no foreign key points at an audit
  table; `deployment_changes` itself has `-> deployments ON DELETE CASCADE`, and no code deletes a deployment).
- Backups use `pg_dump -U tvmf`, Adminer (debug profile) uses the same login.

## Design

1. **Two roles.** `tvmf` stays the owner (migrations, seed, tenant provisioning, backups). A new `tvmf_app` (LOGIN, not superuser)
   is what the api and worker connect as.
2. **Grants** (written by `packages/db/src/migrate.ts` after the migrations, and again at the end of `provisionTenant`):
   `CONNECT`; `USAGE` on `platform` and every tenant schema; `SELECT, INSERT, UPDATE, DELETE` on all tables and `USAGE, SELECT` on
   all sequences (`nextval` is used for request and incident numbers); then **`REVOKE UPDATE, DELETE, TRUNCATE`** on the three audit
   tables. `ALTER DEFAULT PRIVILEGES FOR ROLE tvmf` covers tables later migrations add; the audit revoke is repeated every run.
3. **Opt-in, so nothing breaks on upgrade.** A new optional `DATABASE_APP_URL`. When set, api and worker use it; when empty they use
   `DATABASE_URL` exactly as now (and log once that they are not least-privilege). `migrate.js` and `seed.js` always use
   `DATABASE_URL`. The role's password is `APP_DB_PASSWORD`, read by `migrate.js`, which creates/updates the role (`CREATE ROLE ...
   LOGIN PASSWORD`, so the password never sits in a SQL file).
4. **Installer.** New installs generate `APP_DB_PASSWORD` and write `DATABASE_APP_URL`. Existing installs: `voxshift update` adds the two
   lines to `.env` when missing (it already edits nothing else, so this is a small, explicit step) and restarts; the database role is
   created by the next `migrate.js`. Hosted Dockge stacks (env typed into the Dockge UI) add the two variables by hand.

## What it would and would not protect

| Threat | Protected? |
|---|---|
| A bug or SQL mistake in the app that updates or deletes audit rows | Yes: Postgres refuses. |
| SQL injection (the code uses parameterised Kysely; no known path) | Yes for the audit tables. |
| Someone with the `tvmf_app` password only (a leaked `DATABASE_APP_URL`) | Yes for the audit tables. |
| **Code execution inside the api container** | **No, unless provisioning moves out of the api.** The api process would still hold `DATABASE_URL` (the owner) to create customers, and an attacker reads it from the environment. |
| Someone with the owner password or root on the host | No. A superuser can always change anything. Only shipping the audit log off the host (syslog, a write-only store) addresses that. |

**The real benefit needs one more change:** tenant provisioning would have to run in a process that holds the owner credentials and
the api does not, for example the `migrate` step run on demand by the worker through a separate, tightly scoped connection, or a
one-shot `provision` container the api asks for. Without it, this is defence in depth against bugs and a leaked app password, not
against a compromised api container. That is worth saying plainly to customers either way.

## Risks and costs

- **Cannot be tested here:** no Docker, so the installer and upgrade path (adding to `.env`, role creation on an existing database,
  `pg_dump`/restore with a second role) would be untested until a real install. The database part (two roles, grants, "refuses
  UPDATE/DELETE on audit") can be tested in `tests/db` with the embedded Postgres.
- **A missed grant breaks a feature at runtime**, not at deploy: a table or sequence the app uses but the grants did not cover fails on first
  use. Mitigated by granting on `ALL TABLES/SEQUENCES IN SCHEMA` every run and by running the whole db test suite as `tvmf_app`.
- **Restore:** a dump restored as `tvmf` loses nothing, but the grants must be re-applied (the next `migrate.js` does it).
- **Extensions and functions:** not yet checked. The tables use `citext` and `gen_random_uuid()`; the test run as `tvmf_app` would show whether
  anything else needs a grant.
- **Hub:** the Voxshift Hub has its own database and compose; the same change would be made there separately.

## A cheaper step that could go first

A trigger on the three audit tables (`BEFORE UPDATE OR DELETE OR TRUNCATE ... RAISE EXCEPTION`) in a normal migration. It needs no new
role, no `.env` change and no installer change, and it blocks the same application bugs and SQL injection. It does **not** stop the
owner (who can drop the trigger) and `DROP SCHEMA` does not fire it. Tenant provisioning and user deletion are not affected (no code
path updates those rows today). It can be replaced by the role split later without undoing anything.

## Decision needed

Build the trigger now, the role split later (with the provisioning change), or both. Until then SECURITY.md states the application-only
position.
