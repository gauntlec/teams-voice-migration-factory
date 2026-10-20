// Deleting a customer for good (docs/SECURITY.md "Deleting a customer"): the whole operation against a real Postgres, a real
// temp folder for the files, and an in-memory stand-in for the Redis queues.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateAllTenants } from '@tvmf/db';
import { PLATFORM_TENANT_REFERENCES } from '../../../../apps/api/src/tenants/tenant-data-inventory';
import { TenantGuard } from '../../../../apps/api/src/rbac/tenant.guard';
import { useDb, useGlobalAgentLock } from '../helpers';
import { seedLocalUser } from '../sso/helpers';
import { countWhere, exists, FakeQueue, makeDeletion, pdb, populateCustomer } from './deletion-helpers';

const handle = useDb();
// The populated customers get an assistant row, and assistants are shared by the whole platform: hold the same lock the agent tests use.
useGlobalAgentLock(handle);
const SUPER = { id: '', email: '' };
const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

/** A Super Admin who can answer the code check, and the input for a correct request. */
async function asSuperAdmin(name: string, p: { superAdmin: { id: string; email: string; code: () => string } }) {
  return { actor: { id: p.superAdmin.id, email: p.superAdmin.email, ip: '203.0.113.9' }, input: () => ({ confirmName: name, totpCode: p.superAdmin.code() }) };
}

describe('deleting a populated customer', () => {
  it('removes everything about it, and nothing else', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const bystander = await populateCustomer(handle, d.filesDir); // a second customer that must come through untouched
    const t = p.c.t;
    const who = await asSuperAdmin(p.name, p);

    // The append-only audit tables inside the customer's schema refuse row deletes... and the schema can still be dropped.
    await expect(q(`delete from "${t.schema}".audit_log`)).rejects.toThrow(/append-only/);
    await expect(q(`delete from "${t.schema}".deployment_changes`)).rejects.toThrow(/append-only/);

    // The queues: this customer's jobs, a finished one, another customer's job, and a mail job for a message that will go.
    d.deployQueue.put('connection.start', { tenantId: t.id, schema: t.schema });
    d.deployQueue.put('deployment.run', { tenantId: t.id, schema: t.schema }, 'completed');
    d.deployQueue.put('tenant_discovery.run', { tenantId: t.id, schema: t.schema }, 'failed');
    const bystanderJob = d.deployQueue.put('connection.start', { tenantId: bystander.c.t.id, schema: bystander.c.t.schema });
    const goingEmail = (await q(`select id from platform.email_messages where tenant_id = $1`, [t.id])).rows[0].id;
    const keptEmail = (await q(`select id from platform.email_messages where to_email = $1 and tenant_id is null`, [p.engineer.email])).rows[0].id;
    d.mailQueue.put('send', { id: goingEmail });
    const keptMailJob = d.mailQueue.put('send', { id: keptEmail });
    // An open Microsoft Teams sign-in for this customer in the worker, and one for the bystander.
    let disposed = 0;
    d.deployQueue.executors.set('conn-1', { dispose: async () => void (disposed += 1) });
    d.deployQueue.executorSchema.set('conn-1', t.schema);
    d.deployQueue.executors.set('conn-2', { dispose: async () => undefined });
    d.deployQueue.executorSchema.set('conn-2', bystander.c.t.schema);

    const summary = await d.service.summary(t.id);
    expect(summary.counts).toMatchObject({ sites: 2, usersDeleted: 2, usersLoseAccess: 3, files: 3, incidents: 1, serviceRequests: 1, discoveryRuns: 1, deployments: 1 });
    expect(summary.counts.fileBytes).toBe('doc-one'.length + 'doc-two-longer'.length + 'png'.length);
    expect(summary.counts.emailRecords).toBe(2);
    expect(summary.openSessions).toBe(1);
    expect(summary.blockers).toEqual([]);

    const result = await d.service.delete(t.id, who.input(), who.actor);
    expect(result.deleted).toBe(true);

    // The customer: row, schema and files are gone.
    expect(await countWhere(handle, 'tenants', 'id = $1', [t.id])).toBe(0);
    expect(await exists(handle, t.schema)).toBe(false);
    for (const f of p.files) expect(existsSync(join(d.filesDir, f))).toBe(false);
    expect(existsSync(join(d.filesDir, t.schema))).toBe(false);
    expect(existsSync(join(d.filesDir, 'branding', t.id))).toBe(false);

    // Every platform table that pointed at the customer holds nothing for it (the audit log keeps its record, below).
    for (const e of PLATFORM_TENANT_REFERENCES.filter((x) => x.handling === 'cascade' || x.handling === 'deleted')) {
      expect(await countWhere(handle, e.table, `${e.column} = $1`, [t.id]), `${e.table}.${e.column}`).toBe(0);
    }
    // People who belonged only here are gone with their sessions, authenticator and memberships...
    for (const u of p.onlyHere) {
      expect(await countWhere(handle, 'users', 'id = $1', [u.id])).toBe(0);
      expect(await countWhere(handle, 'auth_sessions', 'user_id = $1', [u.id])).toBe(0);
      expect(await countWhere(handle, 'tenant_memberships', 'user_id = $1', [u.id])).toBe(0);
    }
    // ...their email log rows too (to them, and about the customer), but not unrelated mail to staff.
    expect(await countWhere(handle, 'email_messages', 'to_email = $1', [p.onlyHere[0].email])).toBe(0);
    expect(await countWhere(handle, 'email_messages', 'to_email = $1', [p.engineer.email])).toBe(1);
    expect(await countWhere(handle, 'inbound_email_log', 'from_email = $1', [p.onlyHere[1].email])).toBe(0);
    // Staff, the project manager, the Super Admin and the person who also belongs elsewhere stay; they only lose this membership.
    for (const u of [p.engineer, p.projectManager, p.alsoElsewhere, p.superAdmin]) expect(await countWhere(handle, 'users', 'id = $1', [u.id]), u.email).toBe(1);
    expect(await countWhere(handle, 'tenant_memberships', 'user_id = $1 and tenant_id = $2', [p.alsoElsewhere.id, p.alsoElsewhere.otherTenantId])).toBe(1);
    expect(await countWhere(handle, 'tenant_memberships', 'user_id = $1 and tenant_id = $2', [p.engineer.id, t.id])).toBe(0);
    expect(await countWhere(handle, 'tenant_memberships', 'user_id = $1', [p.alsoElsewhere.id])).toBe(1);
    // The bug report keeps existing but no longer names the customer.
    expect((await q(`select affected_customer from platform.bug_reports where title = 'Broken' and affected_customer is null`)).rowCount).toBeGreaterThanOrEqual(1);

    // Queue: this customer's jobs are gone, everyone else's stay. The Teams sign-in was closed.
    expect(d.deployQueue.forTenant(t.id)).toEqual([]);
    expect(d.deployQueue.jobs).toContain(bystanderJob);
    expect(d.mailQueue.jobs.map((j) => (j.data as { id: string }).id)).toEqual([keptEmail]);
    expect(d.mailQueue.jobs).toContain(keptMailJob);
    expect(disposed).toBe(1);
    expect(d.deployQueue.executors.has('conn-1')).toBe(false);
    expect(d.deployQueue.executors.has('conn-2')).toBe(true);

    // The bystander customer is exactly as it was.
    const b = bystander.c.t;
    expect(await exists(handle, b.schema)).toBe(true);
    expect((await q(`select count(*)::int n from "${b.schema}".discovery_sites`)).rows[0].n).toBe(2);
    expect((await q(`select count(*)::int n from "${b.schema}".audit_log`)).rows[0].n).toBe(1);
    expect(await countWhere(handle, 'tenants', 'id = $1', [b.id])).toBe(1);
    expect(await countWhere(handle, 'tenant_memberships', 'tenant_id = $1', [b.id])).toBe(5);
    expect(await countWhere(handle, 'email_messages', 'tenant_id = $1', [b.id])).toBe(1);
    for (const f of bystander.files) expect(existsSync(join(d.filesDir, f))).toBe(true);
    expect(await countWhere(handle, 'users', 'id = any($1)', [bystander.onlyHere.map((u) => u.id)])).toBe(2);
  });

  it('writes one entry in the platform audit log: who, which customer, how much, and no customer content', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    await d.service.delete(p.c.t.id, who.input(), who.actor);

    const rows = (await q(`select * from platform.platform_audit_log where tenant_id = $1 and action = 'tenant.deleted'`, [p.c.t.id])).rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actor_user_id).toBe(p.superAdmin.id);
    expect(row.actor_email).toBe(p.superAdmin.email);
    expect(row.target_id).toBe(p.c.t.id);
    expect(row.ip).toBe('203.0.113.9');
    expect(row.detail.customerName).toBe(p.name);
    expect(row.detail.removed).toMatchObject({ sites: 2, usersDeleted: 2, usersLostAccess: 3, files: 3, incidents: 1, serviceRequests: 1, deployments: 1 });
    // Nothing from inside the customer: no people, no site names, no ticket text, no addresses, no file names.
    const text = JSON.stringify(row.detail);
    for (const secret of [...p.siteNames, p.incidentTitle, ...p.onlyHere.map((u) => u.email), p.engineer.email, 'secret', 'change.docx', 'logo-1.png']) {
      expect(text, secret).not.toContain(secret);
    }
    // The start of the deletion is recorded too, and so is the earlier history of the customer (the log is append-only).
    expect((await q(`select 1 from platform.platform_audit_log where tenant_id = $1 and action = 'tenant.delete_started'`, [p.c.t.id])).rowCount).toBe(1);
    expect((await q(`select 1 from platform.platform_audit_log where tenant_id = $1 and action = 'tenant.member_added'`, [p.c.t.id])).rowCount).toBe(1);
    await expect(q(`delete from platform.platform_audit_log where id = $1`, [row.id])).rejects.toThrow(/append-only/);
  });
});

describe('who and what is refused', () => {
  it('refuses a wrong typed name, and changes nothing', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    await expect(d.service.delete(p.c.t.id, { confirmName: p.name.toLowerCase(), totpCode: p.superAdmin.code() }, who.actor)).rejects.toMatchObject({ response: { code: 'name_mismatch' } });
    await expect(d.service.delete(p.c.t.id, { confirmName: '', totpCode: p.superAdmin.code() }, who.actor)).rejects.toThrow();
    await assertUntouched(p, d.filesDir);
    expect((await q(`select detail from platform.platform_audit_log where tenant_id = $1 and action = 'tenant.delete_refused'`, [p.c.t.id])).rows[0].detail).toEqual({ reason: 'name_mismatch' });
  });

  it('refuses without a correct authenticator code, and counts the wrong guess towards the lock-out', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    const wrong = p.superAdmin.code() === '000000' ? '111111' : '000000';
    await expect(d.service.delete(p.c.t.id, { confirmName: p.name, totpCode: wrong }, who.actor)).rejects.toMatchObject({ status: 403, response: { code: 'mfa_incorrect' } });
    expect((await q(`select failed_logins from platform.users where id = $1`, [p.superAdmin.id])).rows[0].failed_logins).toBe(1);
    await assertUntouched(p, d.filesDir);
    // A right code afterwards works and clears the counter.
    await d.service.delete(p.c.t.id, who.input(), who.actor);
    expect((await q(`select failed_logins from platform.users where id = $1`, [p.superAdmin.id])).rows[0].failed_logins).toBe(0);
  });

  it('refuses a person with no authenticator set up', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const noMfa = await q(`insert into platform.users (email, password_hash, display_name, role, totp_enrolled) values ($1, '!', 'Fed Admin', 'SUPER_ADMIN', false) returning id`, [`fed-${p.c.t.id.slice(0, 6)}@x.test`]);
    await expect(d.service.delete(p.c.t.id, { confirmName: p.name, totpCode: '123456' }, { id: noMfa.rows[0].id, email: 'fed@x.test' })).rejects.toMatchObject({ response: { code: 'mfa_not_set_up' } });
    await assertUntouched(p, d.filesDir);
  });

  it('refuses while a deployment or a Discovery run is in progress, and says what to do', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    const s = p.c.t.schema;
    await q(`insert into "${s}".deployments (mode, created_by, status) values ('execute', $1, 'running')`, [p.superAdmin.id]);
    await expect(d.service.delete(p.c.t.id, who.input(), who.actor)).rejects.toMatchObject({ status: 409, response: { code: 'busy', message: expect.stringMatching(/deployment.*Wait for it to finish/) } });
    expect((await d.service.summary(p.c.t.id)).blockers.map((b) => b.kind)).toEqual(['deployment']);
    await assertUntouched(p, d.filesDir);

    await q(`update "${s}".deployments set status = 'failed' where status = 'running'`);
    await q(`insert into "${s}".tenant_discovery_runs (started_by, status) values ($1, 'queued')`, [p.superAdmin.id]);
    await expect(d.service.delete(p.c.t.id, who.input(), who.actor)).rejects.toMatchObject({ status: 409, response: { code: 'busy', message: expect.stringMatching(/Discovery run/) } });
    await assertUntouched(p, d.filesDir);

    // Once it has finished, the deletion goes ahead.
    await q(`update "${s}".tenant_discovery_runs set status = 'completed' where status = 'queued'`);
    await d.service.delete(p.c.t.id, who.input(), who.actor);
    expect(await exists(handle, s)).toBe(false);
  });

  it('refuses, and deletes nothing, when the worker does not answer', async () => {
    const queue = new FakeQueue();
    queue.workerAnswers = false;
    const d = makeDeletion(handle, { deployQueue: queue });
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    await expect(d.service.delete(p.c.t.id, who.input(), who.actor)).rejects.toMatchObject({ status: 503, response: { code: 'worker_unavailable' } });
    // The customer is hidden (it was marked) but every byte is still there, ready to be finished.
    expect(await exists(handle, p.c.t.schema)).toBe(true);
    for (const f of p.files) expect(existsSync(join(d.filesDir, f))).toBe(true);
    expect((await q(`select status from platform.tenants where id = $1`, [p.c.t.id])).rows[0].status).toBe('deleting');
    // The worker comes back: the same request finishes the job.
    queue.workerAnswers = true;
    await d.service.delete(p.c.t.id, who.input(), who.actor);
    expect(await exists(handle, p.c.t.schema)).toBe(false);
  });
});

describe('a deletion that stops part way', () => {
  it('hides the customer, locks the people out at once, and finishes when run again', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    // The disk fails once, after the queue and the sign-ins were handled and before anything is deleted.
    const realDeleteFolder = d.storage.deleteFolder.bind(d.storage);
    let calls = 0;
    d.storage.deleteFolder = async (rel: string) => {
      calls += 1;
      if (calls === 1) throw new Error('disk went away');
      return realDeleteFolder(rel);
    };
    await expect(d.service.delete(p.c.t.id, who.input(), who.actor)).rejects.toThrow('disk went away');

    // Marked, hidden, refused to everyone, and the doomed people cannot sign in or use a session.
    expect((await q(`select status from platform.tenants where id = $1`, [p.c.t.id])).rows[0].status).toBe('deleting');
    const asSuper = { id: p.superAdmin.id, role: 'SUPER_ADMIN' as const };
    expect((await d.tenants.list(asSuper)).map((t) => t.id)).not.toContain(p.c.t.id);
    expect((await d.service.pending()).map((t) => t.id)).toContain(p.c.t.id);
    const guard = new TenantGuard(handle.db);
    const ctx = (userId: string, role: string) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { id: userId, role }, params: { tenantId: p.c.t.id } }) }) }) as never;
    await expect(guard.canActivate(ctx(p.superAdmin.id, 'SUPER_ADMIN'))).rejects.toThrow(/not found/);
    await expect(guard.canActivate(ctx(p.engineer.id, 'ENGINEER'))).rejects.toThrow(/not found/);
    for (const u of p.onlyHere) {
      expect((await q(`select status from platform.users where id = $1`, [u.id])).rows[0].status).toBe('disabled');
      expect((await q(`select count(*)::int n from platform.auth_sessions where user_id = $1 and revoked_at is null`, [u.id])).rows[0].n).toBe(0);
    }
    // Branding and members of a hidden customer cannot be reached through the normal customer routes.
    await expect(d.tenants.members(p.c.t.id, asSuper)).rejects.toThrow(/not found/);
    await expect(d.tenants.readLogoBytes(p.c.t.id)).rejects.toThrow(/not found/);
    // The summary still reports the numbers saved when it started.
    const again = await d.service.summary(p.c.t.id);
    expect(again.unfinished).toBe(true);
    expect(again.counts).toMatchObject({ sites: 2, usersDeleted: 2, files: 3 });

    // Run again: it completes, and the audit entry carries the original counts.
    await d.service.delete(p.c.t.id, who.input(), who.actor);
    expect(await countWhere(handle, 'tenants', 'id = $1', [p.c.t.id])).toBe(0);
    expect(await exists(handle, p.c.t.schema)).toBe(false);
    const row = (await q(`select detail from platform.platform_audit_log where action = 'tenant.deleted' and tenant_id = $1`, [p.c.t.id])).rows[0];
    expect(row.detail.removed).toMatchObject({ sites: 2, usersDeleted: 2, files: 3, incidents: 1 });
    // The start was recorded once, not once per attempt.
    expect((await q(`select count(*)::int n from platform.platform_audit_log where action = 'tenant.delete_started' and tenant_id = $1`, [p.c.t.id])).rows[0].n).toBe(1);
  });

  it('finishes when the database schema was already dropped before the customer row went', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    // First attempt dies right after the drop: files and schema are gone, platform rows are not.
    const realQuery = handle.pool.query.bind(handle.pool);
    await d.storage.deleteFolder(p.c.t.schema);
    await q(`update platform.tenants set status = 'deleting', deletion_summary = '{"sites":2,"usersDeleted":2}'::jsonb where id = $1`, [p.c.t.id]);
    await q(`drop schema "${p.c.t.schema}" cascade`);
    expect(realQuery).toBeDefined();
    const result = await d.service.delete(p.c.t.id, who.input(), who.actor);
    expect(result.deleted).toBe(true);
    expect(await countWhere(handle, 'tenants', 'id = $1', [p.c.t.id])).toBe(0);
    expect(await countWhere(handle, 'users', 'id = any($1)', [p.onlyHere.map((u) => u.id)])).toBe(0);
  });

  it('is not undone by the start-up migration, which would otherwise create the dropped schema again', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    await q(`update platform.tenants set status = 'deleting' where id = $1`, [p.c.t.id]);
    await q(`drop schema "${p.c.t.schema}" cascade`);
    const done = await migrateAllTenants(handle.pool);
    expect(Object.keys(done)).not.toContain(p.c.t.schema);
    expect(await exists(handle, p.c.t.schema)).toBe(false);
  });
});

describe('the queue and the worker', () => {
  it('waits for a job in progress to end after its sign-in is closed, then clears it', async () => {
    const queue = new FakeQueue();
    const d = makeDeletion(handle, { deployQueue: queue });
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    const active = queue.put('connection.start', { tenantId: p.c.t.id, schema: p.c.t.schema }, 'active');
    queue.executors.set('c', { dispose: async () => { active.state = 'failed'; } }); // closing the sign-in ends the job, like the real worker
    queue.executorSchema.set('c', p.c.t.schema);
    await d.service.delete(p.c.t.id, who.input(), who.actor);
    expect(queue.forTenant(p.c.t.id)).toEqual([]);
  });

  it('stops, and says so, when a job for the customer will not end', async () => {
    const queue = new FakeQueue();
    const d = makeDeletion(handle, { deployQueue: queue });
    const p = await populateCustomer(handle, d.filesDir);
    const who = await asSuperAdmin(p.name, p);
    queue.put('deployment.run', { tenantId: p.c.t.id, schema: p.c.t.schema }, 'active');
    await expect(d.service.delete(p.c.t.id, who.input(), who.actor)).rejects.toMatchObject({ status: 409, response: { code: 'still_finishing' } });
    expect(await exists(handle, p.c.t.schema)).toBe(true);
  });
});

describe('the list of what points at a customer', () => {
  it('matches the real database: a new table that refers to a customer fails this test until the deletion handles it', async () => {
    // 1. Every foreign key to platform.tenants.
    const fks = (await q(`
      select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype as del
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.confrelid = 'platform.tenants'::regclass`)).rows as { tbl: string; col: string; del: string }[];
    // 2. Every platform column that looks like it holds a customer.
    const looks = (await q(`
      select table_name as tbl, column_name as col from information_schema.columns
       where table_schema = 'platform' and table_name <> 'tenants'
         and (column_name ilike '%tenant%' or column_name ilike '%customer%' or column_name ilike '%schema%')`)).rows as { tbl: string; col: string }[];
    const found = new Map<string, true>();
    for (const f of fks) found.set(`${f.tbl.replace('platform.', '')}.${f.col}`, true);
    for (const l of looks) found.set(`${l.tbl}.${l.col}`, true);
    const listed = new Map(PLATFORM_TENANT_REFERENCES.map((e) => [`${e.table}.${e.column}`, e]));

    const missing = [...found.keys()].filter((k) => !listed.has(k));
    expect(missing, `A platform table now refers to a customer but deleting a customer does not handle it. Add it to PLATFORM_TENANT_REFERENCES (apps/api/src/tenants/tenant-data-inventory.ts) and make TenantDeletionService deal with it: ${missing.join(', ')}`).toEqual([]);
    const stale = [...listed.keys()].filter((k) => !found.has(k));
    expect(stale, `Listed in PLATFORM_TENANT_REFERENCES but no such column: ${stale.join(', ')}`).toEqual([]);

    // The declared handling agrees with how the foreign key is really set up.
    for (const f of fks) {
      const e = listed.get(`${f.tbl.replace('platform.', '')}.${f.col}`)!;
      if (e.handling === 'cascade') expect(f.del, `${e.table}.${e.column} must be ON DELETE CASCADE`).toBe('c');
      if (e.handling === 'deleted') expect(['n', 'a'], `${e.table}.${e.column} is deleted by code, so the foreign key must not cascade`).toContain(f.del);
    }
  });

  it('knows every foreign key to a person that does not clean up by itself, and every schema the database has', async () => {
    const { USER_REFERENCES_NEEDING_CODE } = await import('../../../../apps/api/src/tenants/tenant-data-inventory');
    const fks = (await q(`
      select c.conrelid::regclass::text as tbl, a.attname as col
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.confrelid = 'platform.users'::regclass and c.confdeltype in ('a', 'r')`)).rows as { tbl: string; col: string }[];
    expect(fks.map((f) => `${f.tbl.replace('platform.', '')}.${f.col}`).sort()).toEqual(USER_REFERENCES_NEEDING_CODE.map((e) => `${e.table}.${e.column}`).sort());

    // The only schemas are public, platform, and one per customer: nothing else can hold customer data.
    const schemas = (await q(`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`)).rows.map((r) => r.nspname as string);
    expect(schemas.filter((s) => s !== 'public' && s !== 'platform' && !/^tenant_[a-z0-9]+$/.test(s))).toEqual([]);
  });
});

describe('the file store', () => {
  it('removes a whole folder, is happy when it is already gone, and never touches the storage root or anything outside it', async () => {
    const d = makeDeletion(handle);
    await d.storage.write('tenant_x/a/one.txt', Buffer.from('12345'));
    await d.storage.write('tenant_x/b/two.txt', Buffer.from('678'));
    await d.storage.write('tenant_y/keep.txt', Buffer.from('k'));
    expect(await d.storage.folderStats('tenant_x')).toEqual({ files: 2, bytes: 8 });
    await d.storage.deleteFolder('tenant_x');
    await d.storage.deleteFolder('tenant_x'); // again: not an error
    expect(await d.storage.folderStats('tenant_x')).toEqual({ files: 0, bytes: 0 });
    expect(await d.storage.exists('tenant_y/keep.txt')).toBe(true);
    for (const bad of ['', '.', './', '/', '../elsewhere']) await expect(d.storage.deleteFolder(bad), bad).rejects.toThrow();
    expect(await d.storage.exists('tenant_y/keep.txt')).toBe(true);
  });
});

describe('around the deletion', () => {
  it('the worker refuses jobs for a customer that is being deleted or is gone', async () => {
    const { refuseJobForDeletedCustomer } = await import('../../../../apps/worker/src/tenant-release');
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    await expect(refuseJobForDeletedCustomer(handle.db, { tenantId: p.c.t.id })).resolves.toBeUndefined();
    await expect(refuseJobForDeletedCustomer(handle.db, {})).resolves.toBeUndefined();
    await q(`update platform.tenants set status = 'deleting' where id = $1`, [p.c.t.id]);
    await expect(refuseJobForDeletedCustomer(handle.db, { tenantId: p.c.t.id })).rejects.toThrow(/being deleted/);
    await q(`delete from platform.tenants where id = $1`, [p.c.t.id]);
    await expect(refuseJobForDeletedCustomer(handle.db, { tenantId: p.c.t.id })).rejects.toThrow(/no longer exists/);
  });

  it('a customer-role person with no other customer is deleted; the only Super Admin and staff are never in the list', async () => {
    const d = makeDeletion(handle);
    const p = await populateCustomer(handle, d.filesDir);
    const admin = await seedLocalUser(handle, 'SUPER_ADMIN');
    await q(`insert into platform.tenant_memberships (user_id, tenant_id) values ($1, $2)`, [admin.id, p.c.t.id]); // even if a Super Admin was given a membership
    const doomed = (await d.service.customerOnlyUsers(handle.db, p.c.t.id)).map((u) => u.id).sort();
    expect(doomed).toEqual(p.onlyHere.map((u) => u.id).sort());
  });
});

async function assertUntouched(p: Awaited<ReturnType<typeof populateCustomer>>, filesDir: string) {
  expect((await q(`select status from platform.tenants where id = $1`, [p.c.t.id])).rows[0].status).toBe('active');
  expect(await exists(handle, p.c.t.schema)).toBe(true);
  for (const f of p.files) expect(existsSync(join(filesDir, f))).toBe(true);
  expect(await countWhere(handle, 'users', 'id = any($1)', [p.onlyHere.map((u) => u.id)])).toBe(2);
  expect((await q(`select count(*)::int n from platform.users where id = any($1) and status = 'active'`, [p.onlyHere.map((u) => u.id)])).rows[0].n).toBe(2);
  void SUPER;
  void pdb;
}
