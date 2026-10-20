// Shared by the customer-deletion tests: a stand-in for the Redis queues, a populated customer, and the real services on a test database.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformDb, type DbHandle } from '@tvmf/db';
import type { Role } from '@tvmf/shared';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { LocalDiskStorageBackend } from '../../../../apps/api/src/modules/files/local-disk-storage.backend';
import { TenantDeletionService, type JobLike, type QueueLike } from '../../../../apps/api/src/tenants/tenant-deletion.service';
import { TenantsService } from '../../../../apps/api/src/tenants/tenants.service';
import { releaseTenantSessions } from '../../../../apps/worker/src/tenant-release';
import { makeAuth, seedLocalUser } from '../sso/helpers';
import { seedCustomer, seedSite, seedUser, type TestCustomer } from '../helpers';

/* ------------------------------- the queues ------------------------------- */

export class FakeJob implements JobLike {
  returnvalue: unknown;
  constructor(
    private readonly queue: FakeQueue,
    public id: string,
    public name: string,
    public data: unknown,
    public state: string,
  ) {}
  async remove() {
    if (this.state === 'active') throw new Error('job is locked');
    this.queue.jobs = this.queue.jobs.filter((j) => j !== this);
  }
  async getState() {
    return this.state;
  }
}

/** An in-memory queue. With `worker` set, a `tenant.release` job is answered at once, like the real worker does. */
export class FakeQueue implements QueueLike {
  jobs: FakeJob[] = [];
  /** the worker's open Teams sign-ins, when a worker is simulated */
  executors = new Map<string, { dispose(): Promise<void> }>();
  executorSchema = new Map<string, string>();
  workerAnswers = true;
  private n = 0;

  put(name: string, data: unknown, state = 'waiting') {
    const job = new FakeJob(this, String(++this.n), name, data, state);
    this.jobs.push(job);
    return job;
  }
  async add(name: string, data: unknown) {
    const job = this.put(name, data);
    if (name === 'tenant.release' && this.workerAnswers) {
      const closed = await releaseTenantSessions(this.executors, this.executorSchema, (data as { schema: string }).schema);
      job.returnvalue = { closed };
      job.state = 'completed';
    }
    return job;
  }
  async getJobs(types: string[]) {
    return this.jobs.filter((j) => types.includes(j.state));
  }
  forTenant(tenantId: string) {
    return this.jobs.filter((j) => (j.data as { tenantId?: string }).tenantId === tenantId);
  }
}

/* ------------------------------ the services ------------------------------ */

export function makeDeletion(handle: DbHandle, over: { storage?: LocalDiskStorageBackend; deployQueue?: FakeQueue; mailQueue?: FakeQueue } = {}) {
  const filesDir = mkdtempSync(join(tmpdir(), 'tvmf-files-'));
  const storage = over.storage ?? new LocalDiskStorageBackend({ FILES_DIR: filesDir } as AppConfig);
  const deployQueue = over.deployQueue ?? new FakeQueue();
  const mailQueue = over.mailQueue ?? new FakeQueue();
  const { audit, auth } = makeAuth(handle);
  const service = new TenantDeletionService(handle.db, handle.pool, audit, storage, deployQueue, mailQueue, auth);
  service.timing = { pollMs: 5, releaseTimeoutMs: 150, activeWaitMs: 150 };
  const tenants = new TenantsService(handle.db, handle.pool, new AuditService(handle.db), storage);
  return { service, tenants, storage, filesDir, deployQueue, mailQueue, audit, auth };
}

/* ---------------------------- a populated customer ---------------------------- */

export interface Populated {
  c: TestCustomer;
  name: string;
  superAdmin: Awaited<ReturnType<typeof seedLocalUser>>;
  /** customer-role people who belong only here: deleted with the customer */
  onlyHere: { id: string; email: string }[];
  /** a customer-role person who also belongs to another customer */
  alsoElsewhere: { id: string; email: string; otherTenantId: string };
  engineer: { id: string; email: string };
  projectManager: { id: string; email: string };
  siteNames: string[];
  incidentTitle: string;
  files: string[];
}

const q = (handle: DbHandle, text: string, params: unknown[] = []) => handle.pool.query(text, params);

/** A customer with sites, numbers, incidents, requests, runs, deployments, files on disk, people in several roles, and platform rows. */
export async function populateCustomer(handle: DbHandle, filesDir: string, name = `Contoso ${randomUUID().slice(0, 6)}`): Promise<Populated> {
  const c = await seedCustomer(handle, { name, managedServices: true });
  const other = await seedCustomer(handle, { name: `Other ${randomUUID().slice(0, 6)}` });
  const superAdmin = await seedLocalUser(handle, 'SUPER_ADMIN');

  const mkUser = async (role: Role, label: string) => {
    const u = await seedUser(handle, role, { displayName: `${label} ${randomUUID().slice(0, 4)}` });
    return { id: u.id, email: u.email };
  };
  const onlyHere = [await mkUser('CUSTOMER', 'Pat Customer'), await mkUser('CUSTOMER', 'Sam Customer')];
  const alsoElsewhere = { ...(await mkUser('CUSTOMER', 'Shared Customer')), otherTenantId: other.t.id };
  const engineer = await mkUser('ENGINEER', 'Eve Engineer');
  const projectManager = await mkUser('PROJECT_MANAGER', 'Pam Manager');
  for (const u of [...onlyHere, alsoElsewhere, engineer, projectManager]) {
    await q(handle, `insert into platform.tenant_memberships (user_id, tenant_id) values ($1, $2)`, [u.id, c.t.id]);
  }
  await q(handle, `insert into platform.tenant_memberships (user_id, tenant_id) values ($1, $2)`, [alsoElsewhere.id, other.t.id]);
  await q(handle, `insert into platform.tenant_memberships (user_id, tenant_id) values ($1, $2)`, [engineer.id, other.t.id]);
  // sessions and an authenticator for a person who will be deleted
  for (const u of onlyHere) {
    await q(handle, `insert into platform.auth_sessions (user_id, refresh_hash, family_id, expires_at) values ($1, 'h', gen_random_uuid(), now() + interval '1 day')`, [u.id]);
  }

  // inside the customer's own schema
  const s = c.s;
  const siteNames = [`Site Alpha ${randomUUID().slice(0, 4)}`, `Site Beta ${randomUUID().slice(0, 4)}`];
  for (const n of siteNames) await seedSite(s, { name: n });
  const incidentTitle = `Calls drop at head office ${randomUUID().slice(0, 4)}`;
  const reporter = superAdmin.id;
  await q(handle, `insert into "${c.t.schema}".incidents (title, description, category, impact, urgency, priority, reporter_id) values ($1, 'secret detail', 'voice', 'site', 'cannot_call', 'p2', $2)`, [incidentTitle, reporter]);
  await q(handle, `insert into "${c.t.schema}".service_requests (type, title, requested_by) values ('new_site', 'Add a site', $1)`, [reporter]);
  await q(handle, `insert into "${c.t.schema}".tenant_discovery_runs (started_by, status) values ($1, 'completed')`, [reporter]);
  const dep = await q(handle, `insert into "${c.t.schema}".deployments (mode, created_by, status) values ('dry_run', $1, 'completed') returning id`, [reporter]);
  await q(handle, `insert into "${c.t.schema}".deployment_changes (deployment_id, seq, correlation_id, object_type, cmdlet, result) values ($1, 1, 'c1', 'user', 'Set-CsUser', 'applied')`, [dep.rows[0].id]);
  await q(handle, `insert into "${c.t.schema}".connections (started_by, status) values ($1, 'active')`, [reporter]);
  await q(handle, `insert into "${c.t.schema}".audit_log (action) values ('test.event')`);

  // files on disk: the customer's folder, and a logo
  const files: string[] = [];
  const put = (rel: string, body: string) => {
    const full = join(filesDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
    files.push(rel);
  };
  put(`${c.t.schema}/deployment_change_document/a-change.docx`, 'doc-one');
  put(`${c.t.schema}/handover_pack/b-handover.docx`, 'doc-two-longer');
  put(`branding/${c.t.id}/logo-1.png`, 'png');
  await q(handle, `update platform.tenants set branding = $2::jsonb where id = $1`, [c.t.id, JSON.stringify({ accentColor: '#4657D2', logo: { path: `branding/${c.t.id}/logo-1.png`, contentType: 'image/png', version: 1, width: 1, height: 1 } })]);

  // platform rows about the customer
  const msp = await q(handle, `insert into platform.msps (name, slug) values ($1, $2) returning id`, [`MSP ${randomUUID().slice(0, 4)}`, `msp-${randomUUID().slice(0, 8)}`]);
  await q(handle, `insert into platform.msp_notifications (msp_id, tenant_id, kind, card) values ($1, $2, 'incident', '{"title":"secret card"}')`, [msp.rows[0].id, c.t.id]);
  await q(handle, `insert into platform.email_messages (to_email, template, context, tenant_id, status) values ($1, 'incident_opened', '{"title":"secret"}', $2, 'sent')`, [engineer.email, c.t.id]);
  await q(handle, `insert into platform.email_messages (to_email, template, context, status) values ($1, 'welcome', '{}', 'sent')`, [onlyHere[0].email]);
  await q(handle, `insert into platform.email_messages (to_email, template, context, status) values ($1, 'welcome', '{}', 'sent')`, [engineer.email]); // unrelated: stays
  await q(handle, `insert into platform.inbound_email_log (message_id, from_email, subject, outcome, tenant_id) values ($1, $2, 'my phones', 'created', $3)`, [randomUUID(), onlyHere[1].email, c.t.id]);
  await q(handle, `insert into platform.invitations (email, role, tenant_id, token_hash, invited_by, expires_at) values ('new@cust.test', 'CUSTOMER', $1, 'x', $2, now() + interval '1 day')`, [c.t.id, superAdmin.id]);
  await q(handle, `insert into platform.intake_sources (tenant_id, name, secret_hash, last4) values ($1, 'SBC', 'h', '1234')`, [c.t.id]);
  const agent = await q(handle, `insert into platform.agents (name) values ($1) returning id`, [`Bot ${randomUUID().slice(0, 6)}`]);
  await q(handle, `insert into platform.agent_customer_policy (agent_id, tenant_id) values ($1, $2)`, [agent.rows[0].id, c.t.id]);
  await q(handle, `insert into platform.agent_events (tenant_id, kind, payload) values ($1, 'incident.created', '{}')`, [c.t.id]);
  await q(handle, `insert into platform.inbound_reply_tokens (token, tenant_id, incident_id, user_id, expires_at) values ($1, $2, gen_random_uuid(), $3, now() + interval '1 day')`, [randomUUID(), c.t.id, onlyHere[0].id]);
  await q(handle, `insert into platform.bug_reports (title, area, steps_to_reproduce, expected_behavior, actual_behavior, affected_customer) values ('Broken', 'x', 's', 'e', 'a', $1)`, [name.toUpperCase()]);
  await q(handle, `insert into platform.platform_audit_log (action, tenant_id, detail) values ('tenant.member_added', $1, '{}')`, [c.t.id]);
  return { c, name, superAdmin, onlyHere, alsoElsewhere, engineer, projectManager, siteNames, incidentTitle, files };
}

export const pdb = (handle: DbHandle) => platformDb(handle.db);
export const exists = async (handle: DbHandle, schema: string) =>
  (await q(handle, `select 1 from pg_namespace where nspname = $1`, [schema])).rowCount === 1;
export const countWhere = async (handle: DbHandle, table: string, where: string, params: unknown[]) =>
  Number((await q(handle, `select count(*) n from platform.${table} where ${where}`, params)).rows[0].n);
