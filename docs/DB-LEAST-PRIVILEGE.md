# Database least privilege (step 1 built, the separate role is not)

**Status (2026-10-19).** Step 1, the **audit-table trigger, is built** (platform migration `0035`, tenant migration `0054`): the database
now refuses UPDATE, DELETE and TRUNCATE on `platform.platform_audit_log` and on every customer's `audit_log` and `deployment_changes`,
whichever account asks. See "Step 1: the trigger (built)" below. **Step 2, a separate low-privilege runtime role, is not built**; the rest
of this page is its design, what it would and would not protect, and the risks. "Database access" in [SECURITY.md](SECURITY.md) states the
current position.

## Today (before step 2)

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

## Step 1: the trigger (built)

What was added, in normal migrations (no new role, no `.env` or installer change):

- `platform/0035_audit_log_append_only.sql`: a function `platform.audit_refuse_change()` and, on `platform.platform_audit_log`, a
  row trigger (`BEFORE UPDATE OR DELETE`) and a statement trigger (`BEFORE TRUNCATE`) that raise "audit table ... is append-only".
- `tenant/0054_audit_tables_append_only.sql`: the same pair of triggers on `audit_log` and `deployment_changes`, with the function in the
  customer's own schema. Tenant migrations run for every existing customer when the api starts and for every customer created later
  (`provisionTenant`), so **new customers are protected from the first day** without any extra code.
- Both are safe on a database that already holds audit rows (no row is read or written) and safe to run twice. The tests are in
  `tests/db/src/platform/audit-append-only.db.test.ts` and fail if either migration is removed.

What was checked first: no code path updates or deletes these rows. The only audit-table writes are INSERTs (`AuditService`,
`platform-audit.ts`, the worker's `deployment_changes` insert). The "purge discovered data" action touches discovery tables only. The
invitation-password scrub (`platform/0034`) changed `email_messages`, not an audit table. `deployment_changes` has a foreign key to
`deployments` with `ON DELETE CASCADE`, so deleting a deployment that has recorded changes is now refused; nothing deletes a deployment
(they are the change history). `platform_audit_log` and `audit_log` are referenced by no foreign key.

What still works: inserting rows, reading, `DROP SCHEMA ... CASCADE` (removing a whole customer), and `pg_dump` / `pg_restore` (restore
drops and recreates the tables and triggers, and loads the rows with COPY).

**No bypass switch was added.** No feature needs to change an audit row, and a setting that any SQL statement could turn on would give
back the weakness this removes. If a maintenance task ever really must (for example a legal order to erase a person's details), a
database administrator does it by hand, knowingly: `ALTER TABLE <table> DISABLE TRIGGER audit_append_only_rows;`, the change, then
`ENABLE TRIGGER` again, and the action should be written to the audit log afterwards.

**Limits, plainly.** This is not protection against a database administrator. The owner of the table (`tvmf`, which the application also
uses) can `ALTER TABLE ... DISABLE TRIGGER`, drop the trigger, or drop the table or schema. It stops an application bug, a SQL injection and
a compromised application code path that only runs ordinary statements from rewriting or erasing the trail; code that can run arbitrary
SQL as the owner could still switch the trigger off, which is why step 2 and copying the log off the host remain on the list.

## What remains

- **Step 2: the separate runtime role** (sections "Design" and "Risks and costs" above), with tenant provisioning moved out of the api so that
  a compromised api process does not hold the owner credentials. Replaces nothing in step 1; the trigger stays as a second layer.
- **Shipping the audit log off the host** (syslog or a write-only store), the only protection against someone with the owner password.
- Decision needed from the owner of the product: build step 2 now or later.
