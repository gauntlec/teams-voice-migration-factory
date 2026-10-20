import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { dropTenantSchema, platformDb, type DB } from '@tvmf/db';
import {
  blockerMessage,
  type DeleteTenantInput,
  type TenantDeletionBlocker,
  type TenantDeletionCounts,
  type TenantDeletionResult,
  type TenantDeletionSummary,
} from '@tvmf/shared';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { InjectDb, PG_POOL, type Db } from '../db/db.module';
import { FILE_STORAGE_BACKEND, type FileStorageBackend } from '../modules/files/file-storage.interface';
import { InjectDeployQueue, InjectMailQueue } from '../queue/queue.module';
import type { Pool } from 'pg';

/** The few parts of a BullMQ job and queue this service uses (so a test can stand in for Redis). */
export interface JobLike {
  id?: string;
  name: string;
  data: unknown;
  returnvalue?: unknown;
  failedReason?: string;
  remove(): Promise<void>;
  getState(): Promise<string>;
}
export interface QueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<JobLike>;
  getJobs(types: string[]): Promise<JobLike[]>;
}

export interface DeletionActor {
  id: string;
  email: string;
  ip?: string | null;
}

/** Every state a job can wait or rest in except `active` (a job being worked on cannot be removed). */
const RESTING_STATES = ['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children', 'completed', 'failed'];

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  schema_name: string;
  status: 'active' | 'archived' | 'deleting';
  deletion_summary: Record<string, number> | null;
}

interface DoomedUser {
  id: string;
  email: string;
}

const zeroCounts = (): TenantDeletionCounts => ({
  sites: 0,
  usersDeleted: 0,
  usersLoseAccess: 0,
  files: 0,
  fileBytes: 0,
  incidents: 0,
  serviceRequests: 0,
  discoveryRuns: 0,
  deployments: 0,
  numberPorts: 0,
  emailRecords: 0,
});

/**
 * Deleting a customer and ALL of its data for good. Super Admin only (permission `tenant:delete`, enforced on the route; this
 * class is the only place that does it). docs/SECURITY.md "Deleting a customer" is the plain-language version.
 *
 * The order is deliberate, and every step can be run again after a failure:
 *   1. refuse unless the typed name and a fresh authenticator code are right, and no deployment or Discovery run is in flight;
 *   2. mark the customer 'deleting' (hidden from every list, nobody can open it, background work skips it) and save the counts;
 *   3. lock out the people who will be deleted and end their sessions, so they stop working at once;
 *   4. clear the queue of this customer's jobs, and make the worker close any open Microsoft Teams sign-in;
 *   5. delete the customer's files from disk;
 *   6. drop the customer's whole database schema;
 *   7. in ONE database transaction: remove the platform rows (email log, notifications, people who belonged only here), write the
 *      audit entry, and delete the customer row last.
 * Until step 7 commits the customer row still exists, so "Finish deleting" on the Customers page runs the same steps again.
 */
@Injectable()
export class TenantDeletionService {
  /** How long to wait for the worker, in milliseconds. Tests make these small. */
  timing = { pollMs: 250, releaseTimeoutMs: 30_000, activeWaitMs: 15_000 };

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE_BACKEND) private readonly storage: FileStorageBackend,
    @InjectDeployQueue() private readonly deployQueue: QueueLike,
    @InjectMailQueue() private readonly mailQueue: QueueLike,
    private readonly auth: AuthService,
  ) {}

  /* ------------------------------ read side ------------------------------ */

  /** Customers whose deletion started and did not finish. Only a Super Admin sees them, on the Customers page. */
  pending() {
    return platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'name', 'slug', 'deletion_started_at'])
      .where('status', '=', 'deleting')
      .orderBy('name')
      .execute();
  }

  /** What would be deleted, in numbers, and whether anything stops it right now. Changes nothing. */
  async summary(tenantId: string): Promise<TenantDeletionSummary> {
    const tenant = await this.load(tenantId);
    const doomed = await this.customerOnlyUsers(this.db, tenant.id);
    const blockers = await this.blockers(tenant);
    const unfinished = tenant.status === 'deleting';
    const counts =
      unfinished && tenant.deletion_summary
        ? { ...zeroCounts(), ...tenant.deletion_summary }
        : await this.countEverything(tenant, doomed);
    return {
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
      counts,
      openSessions: await this.countRows(tenant.schema_name, 'connections', sql`status in ('pending','active')`),
      blockers,
      unfinished,
    };
  }

  /* ------------------------------ the deletion ----------------------------- */

  async delete(tenantId: string, input: DeleteTenantInput, actor: DeletionActor): Promise<TenantDeletionResult> {
    const tenant = await this.load(tenantId);

    // 1. Deliberate, not accidental: the exact name, then a fresh authenticator code.
    if (input.confirmName !== tenant.name) {
      await this.refused(tenant, actor, 'name_mismatch');
      throw new BadRequestException({ code: 'name_mismatch', message: 'The name you typed does not match this customer. Type it exactly as it is shown.' });
    }
    try {
      await this.auth.requireFreshMfa(actor.id, actor.email, input.totpCode, { ip: actor.ip ?? undefined });
    } catch (e) {
      const code = (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code ?? 'mfa_incorrect';
      await this.refused(tenant, actor, code);
      throw e;
    }
    await this.refuseWhileBusy(tenant);

    // 2. Mark it. From here on the customer is hidden and cannot be opened.
    const previousStatus = tenant.status;
    let counts: TenantDeletionCounts;
    if (previousStatus !== 'deleting') {
      const doomedNow = await this.customerOnlyUsers(this.db, tenant.id);
      counts = await this.countEverything(tenant, doomedNow);
      await platformDb(this.db)
        .updateTable('tenants')
        .set({
          status: 'deleting',
          deletion_started_at: new Date().toISOString(),
          deletion_started_by: actor.id,
          deletion_summary: JSON.stringify(counts),
        })
        .where('id', '=', tenant.id)
        .execute();
      await this.audit.platform('tenant.delete_started', {
        actor,
        targetType: 'tenant',
        targetId: tenant.id,
        tenantId: tenant.id,
        detail: { customerName: tenant.name },
      });
      // Someone may have started work in the instant between the check and the mark. Put it back and say so.
      const raced = await this.blockers(tenant);
      if (raced.length) {
        await platformDb(this.db)
          .updateTable('tenants')
          .set({ status: previousStatus, deletion_started_at: null, deletion_started_by: null, deletion_summary: null })
          .where('id', '=', tenant.id)
          .execute();
        await this.refused(tenant, actor, 'busy');
        throw this.busyError(raced);
      }
    } else {
      counts = { ...zeroCounts(), ...(tenant.deletion_summary ?? {}) };
    }

    // 3. The people who go with the customer stop working at once.
    const doomed = await this.customerOnlyUsers(this.db, tenant.id);
    await this.lockOut(doomed);

    // 4. Jobs and the Teams sign-in.
    const emailIds = await this.emailRecordIds(tenant.id, doomed);
    const { jobsRemoved, sessionsClosed } = await this.stopWork(tenant, emailIds);

    // 5. + 6. Files, then the database schema.
    await this.storage.deleteFolder(tenant.schema_name);
    await this.storage.deleteFolder(`branding/${tenant.id}`);
    await dropTenantSchema(this.pool, tenant.schema_name);

    // 7. The platform rows, the audit entry, and the customer row, all or nothing.
    const removed = await this.removePlatformRows(tenant, actor, counts, { jobsRemoved, sessionsClosed });
    return { deleted: true, counts: { ...counts, emailRecords: removed.emailRecords } };
  }

  /* -------------------------------- steps -------------------------------- */

  private async load(tenantId: string): Promise<TenantRow> {
    const t = await platformDb(this.db)
      .selectFrom('tenants')
      .select(['id', 'name', 'slug', 'schema_name', 'status', 'deletion_summary'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!t) throw new NotFoundException('That customer was not found. It may already have been deleted.');
    return t as TenantRow;
  }

  /**
   * People who belong ONLY to this customer and are customer-role users. They are deleted with it. Staff (engineers, project
   * managers), Super Admins, and anyone who also belongs to another customer are never in this list: they just lose the membership.
   */
  async customerOnlyUsers(db: Kysely<DB>, tenantId: string): Promise<DoomedUser[]> {
    return platformDb(db)
      .selectFrom('users as u')
      .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
      .select(['u.id as id', 'u.email as email'])
      .where('m.tenant_id', '=', tenantId)
      .where('u.role', '=', 'CUSTOMER')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('tenant_memberships as other')
              .select('other.user_id')
              .whereRef('other.user_id', '=', 'u.id')
              .where('other.tenant_id', '!=', tenantId),
          ),
        ),
      )
      .execute() as Promise<DoomedUser[]>;
  }

  private async countRows(schema: string, table: string, where?: ReturnType<typeof sql>): Promise<number> {
    if (!/^tenant_[a-z0-9_]+$/.test(schema)) return 0;
    try {
      const q = where
        ? sql<{ n: number }>`select count(*)::int as n from ${sql.table(`${schema}.${table}`)} where ${where}`
        : sql<{ n: number }>`select count(*)::int as n from ${sql.table(`${schema}.${table}`)}`;
      const r = await q.execute(this.db);
      return r.rows[0]?.n ?? 0;
    } catch {
      return 0; // the schema or table is not there (an earlier attempt already dropped it)
    }
  }

  private async countEverything(tenant: TenantRow, doomed: DoomedUser[]): Promise<TenantDeletionCounts> {
    const s = tenant.schema_name;
    const memberRows = await platformDb(this.db)
      .selectFrom('tenant_memberships')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirstOrThrow();
    const folder = await this.storage.folderStats(s);
    const logo = await this.storage.folderStats(`branding/${tenant.id}`);
    return {
      sites: await this.countRows(s, 'discovery_sites'),
      usersDeleted: doomed.length,
      usersLoseAccess: Math.max(0, Number(memberRows.n) - doomed.length),
      files: folder.files + logo.files,
      fileBytes: folder.bytes + logo.bytes,
      incidents: await this.countRows(s, 'incidents'),
      serviceRequests: await this.countRows(s, 'service_requests'),
      discoveryRuns: await this.countRows(s, 'tenant_discovery_runs'),
      deployments: await this.countRows(s, 'deployments'),
      numberPorts: await this.countRows(s, 'number_port_requests'),
      emailRecords: (await this.emailRecordIds(tenant.id, doomed)).length,
    };
  }

  /** Deployments and Discovery runs that are queued or running cannot be cut off safely. */
  private async blockers(tenant: TenantRow): Promise<TenantDeletionBlocker[]> {
    const out: TenantDeletionBlocker[] = [];
    const deployments = await this.countRows(tenant.schema_name, 'deployments', sql`status in ('queued','running')`);
    if (deployments) out.push({ kind: 'deployment', count: deployments, message: blockerMessage('deployment', deployments) });
    const runs = await this.countRows(tenant.schema_name, 'tenant_discovery_runs', sql`status in ('queued','running')`);
    if (runs) out.push({ kind: 'discovery', count: runs, message: blockerMessage('discovery', runs) });
    return out;
  }

  private busyError(blockers: TenantDeletionBlocker[]) {
    return new ConflictException({ code: 'busy', message: blockers.map((b) => b.message).join(' '), blockers });
  }

  private async refuseWhileBusy(tenant: TenantRow) {
    const blockers = await this.blockers(tenant);
    if (blockers.length) {
      await this.refused(tenant, undefined, 'busy');
      throw this.busyError(blockers);
    }
  }

  /** A refused attempt is recorded too: who tried, and why it was refused (a code, never the typed values). */
  private async refused(tenant: TenantRow, actor: DeletionActor | undefined, reason: string) {
    await this.audit.platform('tenant.delete_refused', {
      actor,
      targetType: 'tenant',
      targetId: tenant.id,
      tenantId: tenant.id,
      detail: { reason },
    });
  }

  private async lockOut(doomed: DoomedUser[]) {
    if (!doomed.length) return;
    const ids = doomed.map((u) => u.id);
    const now = new Date().toISOString();
    await platformDb(this.db).updateTable('users').set({ status: 'disabled', updated_at: now }).where('id', 'in', ids).execute();
    await platformDb(this.db).updateTable('auth_sessions').set({ revoked_at: now }).where('user_id', 'in', ids).where('revoked_at', 'is', null).execute();
  }

  /** Ids of the email-log rows to remove: about this customer, or sent to a person who is deleted with it. */
  private async emailRecordIds(tenantId: string, doomed: DoomedUser[]): Promise<string[]> {
    const emails = doomed.map((u) => u.email);
    const rows = await platformDb(this.db)
      .selectFrom('email_messages')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('tenant_id', '=', tenantId),
          ...(emails.length ? [eb('to_email', 'in', emails), eb('original_to_email', 'in', emails)] : []),
        ]),
      )
      .execute();
    return rows.map((r) => r.id);
  }

  /* ------------------------- queue and Teams sessions ----------------------- */

  private async removeJobs(queue: QueueLike, states: string[], matches: (data: unknown) => boolean): Promise<number> {
    let n = 0;
    for (const job of await queue.getJobs(states)) {
      if (!matches(job.data)) continue;
      try {
        await job.remove();
        n += 1;
      } catch {
        /* a job the worker holds right now cannot be removed; the worker step below deals with it */
      }
    }
    return n;
  }

  private async stopWork(tenant: TenantRow, emailIds: string[]): Promise<{ jobsRemoved: number; sessionsClosed: number }> {
    const isThisCustomer = (d: unknown) => {
      const data = d as { tenantId?: string; schema?: string } | null;
      return !!data && (data.tenantId === tenant.id || data.schema === tenant.schema_name);
    };
    let jobsRemoved = await this.removeJobs(this.deployQueue, RESTING_STATES, isThisCustomer);

    // The worker holds the Microsoft Teams sign-ins in its memory, so only the worker can close them.
    const sessionsClosed = await this.askWorkerToClose(tenant);

    // A job that was in progress ends as soon as its sign-in is closed. Wait for that, then clear what it left behind.
    const deadline = Date.now() + this.timing.activeWaitMs;
    while ((await this.deployQueue.getJobs(['active'])).some((j) => isThisCustomer(j.data))) {
      if (Date.now() > deadline) {
        throw new ConflictException({
          code: 'still_finishing',
          message: 'Something for this customer is still finishing in the background. Wait a minute and press "Finish deleting" to continue.',
        });
      }
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
    jobsRemoved += await this.removeJobs(this.deployQueue, RESTING_STATES, isThisCustomer);

    const ids = new Set(emailIds);
    if (ids.size) {
      jobsRemoved += await this.removeJobs(this.mailQueue, [...RESTING_STATES, 'active'], (d) => ids.has((d as { id?: string } | null)?.id ?? ''));
    }
    return { jobsRemoved, sessionsClosed };
  }

  private async askWorkerToClose(tenant: TenantRow): Promise<number> {
    const job = await this.deployQueue.add(
      'tenant.release',
      { tenantId: tenant.id, schema: tenant.schema_name },
      { removeOnComplete: { age: 600 }, removeOnFail: { age: 600 } },
    );
    const deadline = Date.now() + this.timing.releaseTimeoutMs;
    for (;;) {
      const state = await job.getState();
      if (state === 'completed') {
        const closed = (job.returnvalue as { closed?: number } | undefined)?.closed ?? 0;
        await job.remove().catch(() => undefined);
        return closed;
      }
      if (state === 'failed') {
        await job.remove().catch(() => undefined);
        throw new ServiceUnavailableException({ code: 'worker_unavailable', message: 'The background worker could not close this customer\'s Microsoft Teams sign-in. Nothing has been deleted yet. Try again in a minute.' });
      }
      if (Date.now() > deadline) {
        await job.remove().catch(() => undefined);
        throw new ServiceUnavailableException({
          code: 'worker_unavailable',
          message: 'The background worker did not answer, so open Microsoft Teams sign-ins could not be closed. The customer is hidden but its data is still there. Check that the worker is running, then press "Finish deleting".',
        });
      }
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
  }

  /* ----------------------------- the final step ---------------------------- */

  private async removePlatformRows(
    tenant: TenantRow,
    actor: DeletionActor,
    counts: TenantDeletionCounts,
    work: { jobsRemoved: number; sessionsClosed: number },
  ): Promise<{ emailRecords: number }> {
    return this.db.transaction().execute(async (trx) => {
      const p = platformDb(trx);
      // Worked out again inside the transaction, so a person added at the last moment is not missed.
      const doomed = await this.customerOnlyUsers(trx, tenant.id);
      const doomedIds = doomed.map((u) => u.id);
      const emails = doomed.map((u) => u.email);

      const emailWhere = (eb: any, col: string, ...extra: string[]) =>
        eb.or([eb('tenant_id', '=', tenant.id), ...(emails.length ? [col, ...extra].map((c) => eb(c, 'in', emails)) : [])]);

      const emailsRemoved = Number(
        (await p.deleteFrom('email_messages').where((eb) => emailWhere(eb, 'to_email', 'original_to_email')).executeTakeFirst()).numDeletedRows,
      );
      await p.deleteFrom('inbound_email_log').where((eb) => emailWhere(eb, 'from_email')).execute();
      await p.deleteFrom('msp_notifications').where('tenant_id', '=', tenant.id).execute();
      if (emails.length) await p.deleteFrom('sso_link_requests').where('email', 'in', emails).execute();
      await p
        .deleteFrom('invitations')
        .where((eb) =>
          eb.or([eb('tenant_id', '=', tenant.id), ...(emails.length ? [eb('email', 'in', emails)] : []), ...(doomedIds.length ? [eb('invited_by', 'in', doomedIds)] : [])]),
        )
        .execute();
      const scrubbed = Number(
        (await p
          .updateTable('bug_reports')
          .set({ affected_customer: null })
          .where(sql<boolean>`lower(affected_customer) = lower(${tenant.name})`)
          .executeTakeFirst()).numUpdatedRows,
      );

      // The people who belonged only here. Their sessions, authenticator, memberships and single sign-on links go with them.
      if (doomedIds.length) await p.deleteFrom('users').where('id', 'in', doomedIds).execute();

      // The audit entry: who, which customer, how much. No customer content. It is written in this transaction, so it exists
      // exactly when the deletion has happened.
      await p
        .insertInto('platform_audit_log')
        .values({
          action: 'tenant.deleted',
          actor_user_id: actor.id,
          actor_email: actor.email,
          target_type: 'tenant',
          target_id: tenant.id,
          tenant_id: tenant.id,
          ip: actor.ip ?? null,
          detail: {
            customerName: tenant.name,
            customerSlug: tenant.slug,
            removed: {
              sites: counts.sites,
              usersDeleted: doomedIds.length,
              usersLostAccess: counts.usersLoseAccess,
              files: counts.files,
              fileBytes: counts.fileBytes,
              incidents: counts.incidents,
              serviceRequests: counts.serviceRequests,
              discoveryRuns: counts.discoveryRuns,
              deployments: counts.deployments,
              numberPorts: counts.numberPorts,
              emailRecords: emailsRemoved,
              queuedJobs: work.jobsRemoved,
              teamsSessionsClosed: work.sessionsClosed,
              bugReportsScrubbed: scrubbed,
            },
          } as object,
        })
        .execute();

      await p.deleteFrom('tenants').where('id', '=', tenant.id).execute();
      return { emailRecords: emailsRemoved };
    });
  }
}
