import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { emailEnabled, platformDb, tenantDb, webOrigin } from '@tvmf/db';
import {
  isGlobalRole,
  nextScheduleRun,
  REPORT_CATALOGUE,
  reportAvailableFor,
  reportFileName,
  reportPeriodLabel,
  SCHEDULE_FREQUENCY_LABELS,
  SCHEDULE_PERIOD,
  type ReportKey,
  type ReportScheduleInput,
  type ReportScheduleView,
  type Role,
  type ScheduledReportContext,
  type ScheduleFrequency,
  type ScheduleRecipient,
  type SentReportView,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { MailService } from '../../mail/mail.service';
import { DocumentBrandingService } from '../branding/document-branding.service';
import { InsightsReportsService } from './insights-reports.service';
import { renderReportPdf } from './report-pdf';

/** How often the api looks for schedules that are due. */
const CHECK_EVERY_MS = 15 * 60_000;
/** Attachment content is removed from the email log after this long (the message row stays). */
const ATTACHMENT_DAYS = 90;
/** Reports › Sent shows at most this many copies, newest first. */
const SENT_LIMIT = 500;

interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** null = the whole customer; ids = a site contact's sites; undefined = can't open the customer */
  scope: string[] | null | undefined;
}

/**
 * Scheduled reports (docs/INSIGHTS.md, step 4b): a report emailed with its PDF, monthly or quarterly, to people who can
 * open the customer. Every copy is built as that person: their role decides what is in it, and a site contact gets
 * their own sites only - exactly what they would see on the Reports page. A person who has lost access is skipped.
 */
@Injectable()
export class InsightsScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReportSchedules');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly reports: InsightsReportsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    /** whose branding the PDFs carry (docs/BRANDING.md); optional so tests can leave it out (Voxshift's) */
    @Optional() private readonly branding?: DocumentBrandingService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST || process.env.REPORT_SCHEDULES === 'off') return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`schedule pass failed: ${(e as Error).message}`)), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ------------------------------ people ------------------------------ */

  /** Everyone who can open this customer: Super Admins, and the customer's members (staff and its own users), active only. */
  async candidates(t: TenantContext): Promise<ScheduleRecipient[]> {
    const rows = await platformDb(this.db)
      .selectFrom('users as u')
      .leftJoin('tenant_memberships as m', (j) => j.onRef('m.user_id', '=', 'u.id').on('m.tenant_id', '=', t.id))
      .select(['u.id as id', 'u.display_name as name', 'u.email as email', 'u.role as role', 'm.user_id as member'])
      .where('u.status', '=', 'active')
      .where((eb) => eb.or([eb('u.role', '=', 'SUPER_ADMIN'), eb('m.user_id', 'is not', null)]))
      .orderBy('u.display_name')
      .execute();
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role as Role, ok: true }));
  }

  /** The people a schedule names, with what each may see of the customer now. */
  private async people(t: TenantContext, ids: string[]): Promise<Map<string, Person>> {
    if (!ids.length) return new Map();
    const rows = await platformDb(this.db)
      .selectFrom('users as u')
      .leftJoin('tenant_memberships as m', (j) => j.onRef('m.user_id', '=', 'u.id').on('m.tenant_id', '=', t.id))
      .select(['u.id as id', 'u.display_name as name', 'u.email as email', 'u.role as role', 'u.status as status', 'm.user_id as member', 'm.site_ids as siteIds'])
      .where('u.id', 'in', ids)
      .execute();
    return new Map(
      rows.map((r) => {
        const role = r.role as Role;
        // The same rule as TenantGuard: a Super Admin sees every customer; anyone else must be a member, perhaps of some sites only.
        const scope =
          r.status !== 'active' ? undefined : isGlobalRole(role) ? null : r.member ? (Array.isArray(r.siteIds) && r.siteIds.length ? (r.siteIds as string[]) : null) : undefined;
        return [r.id, { id: r.id, name: r.name, email: r.email, role, scope }];
      }),
    );
  }

  /* ------------------------------ schedules ------------------------------ */

  async list(t: TenantContext): Promise<ReportScheduleView[]> {
    const rows = await tenantDb(this.db, t.schema).selectFrom('report_schedules').selectAll().orderBy('created_at').execute();
    const ids = [...new Set(rows.flatMap((r) => [...(r.recipients as string[]), ...(r.created_by ? [r.created_by] : [])]))];
    const people = await this.people(t, ids);
    return rows.map((r) => ({
      id: r.id,
      reportKey: r.report_key as ReportKey,
      reportTitle: REPORT_CATALOGUE[r.report_key as ReportKey]?.title ?? r.report_key,
      frequency: r.frequency,
      recipients: (r.recipients as string[]).map((id) => {
        const p = people.get(id);
        return p ? { id, name: p.name, email: p.email, role: p.role, ok: p.scope !== undefined } : { id, name: 'Removed user', email: '', role: 'CUSTOMER' as Role, ok: false };
      }),
      enabled: r.enabled,
      nextRunAt: new Date(r.next_run_at).toISOString(),
      lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
      lastStatus: r.last_status,
      lastDetail: r.last_detail,
      createdBy: r.created_by ? (people.get(r.created_by)?.name ?? null) : null,
    }));
  }

  private async check(t: TenantContext, input: ReportScheduleInput) {
    if (!reportAvailableFor(input.reportKey, () => true, { managedServices: t.managedServices, monitoring: !!t.monitoringEnabled })) {
      throw new BadRequestException(`${REPORT_CATALOGUE[input.reportKey].title} isn’t available for this customer.`);
    }
    const allowed = new Set((await this.candidates(t)).map((c) => c.id));
    const outsiders = input.recipients.filter((id) => !allowed.has(id));
    if (outsiders.length) throw new BadRequestException('Reports can only be sent to people who can open this customer in Voxshift.');
  }

  /**
   * Reports › Sent (step 6b): every copy of a scheduled report emailed for this customer, newest first, from the email log
   * (at most `SENT_LIMIT`). The PDF that went is offered while it is kept (ATTACHMENT_DAYS).
   */
  async sent(t: TenantContext): Promise<SentReportView[]> {
    const p = platformDb(this.db);
    const rows = await p
      .selectFrom('email_messages as m')
      .leftJoin('email_attachments as a', 'a.message_id', 'm.id')
      .leftJoin('users as u', 'u.id', 'm.created_by')
      .select([
        'm.id as id',
        'm.created_at as created_at',
        'm.to_email as to_email',
        'm.to_name as to_name',
        'm.original_to_email as original_to_email',
        'm.status as status',
        'm.error as error',
        'm.context as context',
        'a.filename as filename',
        sql<boolean>`a.content is not null`.as('kept'),
        'u.display_name as sent_by',
      ])
      .where('m.tenant_id', '=', t.id)
      .where('m.template', '=', 'scheduled_report')
      .orderBy('m.created_at', 'desc')
      .limit(SENT_LIMIT)
      .execute();
    return rows.map((r) => {
      const c = (r.context ?? {}) as Partial<ScheduledReportContext>;
      let path: string | null = null;
      try {
        if (c.url) {
          // stored as the full address; relative when no web address was set
          const u = new URL(c.url, 'http://x');
          path = `${u.pathname}${u.search}`;
        }
      } catch {
        path = null;
      }
      return {
        id: r.id,
        at: new Date(r.created_at).toISOString(),
        reportTitle: c.reportTitle ?? 'Report',
        periodLabel: c.periodLabel ?? '',
        // a test customer's mail is redirected: show who it was for
        toEmail: r.original_to_email ?? r.to_email,
        toName: r.to_name,
        status: r.status,
        error: r.error,
        path,
        pdf: r.filename && r.kept ? { filename: r.filename } : null,
        sentBy: r.sent_by ?? null,
      };
    });
  }

  /** The PDF a sent copy carried, while it is kept. Only this customer's scheduled reports. */
  async sentPdf(t: TenantContext, messageId: string): Promise<{ filename: string; content: Buffer }> {
    const row = await platformDb(this.db)
      .selectFrom('email_attachments as a')
      .innerJoin('email_messages as m', 'm.id', 'a.message_id')
      .select(['a.filename', 'a.content'])
      .where('m.id', '=', messageId)
      .where('m.tenant_id', '=', t.id)
      .where('m.template', '=', 'scheduled_report')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('No such report was sent for this customer.');
    if (!row.content) throw new NotFoundException(`The PDF is kept for ${ATTACHMENT_DAYS} days after it is sent; open the report for the same period instead.`);
    return { filename: row.filename, content: row.content };
  }

  async create(t: TenantContext, user: AuthedUser, input: ReportScheduleInput, now = new Date()) {
    await this.check(t, input);
    const row = await tenantDb(this.db, t.schema)
      .insertInto('report_schedules')
      .values({
        report_key: input.reportKey,
        frequency: input.frequency,
        recipients: JSON.stringify([...new Set(input.recipients)]) as never,
        enabled: input.enabled ?? true,
        next_run_at: nextScheduleRun(input.frequency, now).toISOString(),
        created_by: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'insights.schedule_created', {
      actor: { id: user.id, email: user.email },
      targetType: 'report_schedule',
      targetId: row.id,
      detail: { report: input.reportKey, frequency: input.frequency, recipients: input.recipients.length },
    });
    return (await this.list(t)).find((x) => x.id === row.id)!;
  }

  async update(t: TenantContext, user: AuthedUser, id: string, input: ReportScheduleInput, now = new Date()) {
    await this.check(t, input);
    const s = tenantDb(this.db, t.schema);
    const before = await s.selectFrom('report_schedules').select(['frequency', 'next_run_at']).where('id', '=', id).executeTakeFirst();
    if (!before) throw new NotFoundException('Schedule not found.');
    await s
      .updateTable('report_schedules')
      .set({
        report_key: input.reportKey,
        frequency: input.frequency,
        recipients: JSON.stringify([...new Set(input.recipients)]) as never,
        enabled: input.enabled ?? true,
        ...(before.frequency !== input.frequency ? { next_run_at: nextScheduleRun(input.frequency, now).toISOString() } : {}),
        updated_at: now.toISOString(),
      })
      .where('id', '=', id)
      .execute();
    await this.audit.tenant(t.schema, 'insights.schedule_updated', {
      actor: { id: user.id, email: user.email },
      targetType: 'report_schedule',
      targetId: id,
      detail: { report: input.reportKey, frequency: input.frequency, recipients: input.recipients.length, enabled: input.enabled ?? true },
    });
    return (await this.list(t)).find((x) => x.id === id)!;
  }

  async remove(t: TenantContext, user: AuthedUser, id: string) {
    const res = await tenantDb(this.db, t.schema).deleteFrom('report_schedules').where('id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw new NotFoundException('Schedule not found.');
    await this.audit.tenant(t.schema, 'insights.schedule_deleted', { actor: { id: user.id, email: user.email }, targetType: 'report_schedule', targetId: id });
  }

  /** Sends a schedule now, for the period it would cover now, without moving its next send. */
  async sendNow(t: TenantContext, user: AuthedUser, id: string, now = new Date()) {
    const row = await tenantDb(this.db, t.schema).selectFrom('report_schedules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Schedule not found.');
    const result = await this.run(t, row, now, user.id);
    await this.audit.tenant(t.schema, 'insights.schedule_sent_now', { actor: { id: user.id, email: user.email }, targetType: 'report_schedule', targetId: id, detail: result });
    return result;
  }

  /* ------------------------------ sending ------------------------------ */

  /** One pass over every active customer's due schedules. Returns how many schedules ran. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let ran = 0;
    try {
      const tenants = await platformDb(this.db)
        .selectFrom('tenants')
        .select(['id', 'slug', 'name', 'schema_name', 'teams_read_only', 'managed_services_enabled', 'monitoring_enabled'])
        .where('status', '=', 'active')
        .execute();
      for (const r of tenants) {
        const t: TenantContext = {
          id: r.id,
          slug: r.slug,
          name: r.name,
          schema: r.schema_name,
          siteScope: null,
          teamsReadOnly: !!r.teams_read_only,
          managedServices: !!r.managed_services_enabled,
          monitoringEnabled: !!r.monitoring_enabled,
        };
        const s = tenantDb(this.db, t.schema);
        // One customer that can't be read (being created or deleted right now) must not stop every other customer's reports.
        let due: Awaited<ReturnType<typeof this.dueFor>>;
        try {
          due = await this.dueFor(t, now);
        } catch (e) {
          this.log.warn(`${r.slug}: ${(e as Error).message}`);
          continue;
        }
        for (const sched of due) {
          // Move the next send first, so a failure part-way never sends the same report twice.
          await s.updateTable('report_schedules').set({ next_run_at: nextScheduleRun(sched.frequency, now).toISOString() }).where('id', '=', sched.id).execute();
          try {
            await this.run(t, sched, now, null);
          } catch (e) {
            this.log.warn(`${r.slug} schedule ${sched.id}: ${(e as Error).message}`);
          }
          ran++;
        }
      }
      // Attachment content is kept for Resend for a while, then removed (the email log keeps the message).
      await platformDb(this.db)
        .updateTable('email_attachments')
        .set({ content: null })
        .where('content', 'is not', null)
        .where('created_at', '<', new Date(now.getTime() - ATTACHMENT_DAYS * 86_400_000).toISOString())
        .execute();
    } finally {
      this.running = false;
    }
    return ran;
  }

  private dueFor(t: TenantContext, now: Date) {
    return tenantDb(this.db, t.schema).selectFrom('report_schedules').selectAll().where('enabled', '=', true).where('next_run_at', '<=', now.toISOString()).execute();
  }

  /** Builds and queues one copy per person, as that person. Records the outcome on the schedule. */
  private async run(
    t: TenantContext,
    sched: { id: string; report_key: string; frequency: ScheduleFrequency; recipients: unknown },
    now: Date,
    triggeredBy: string | null,
  ): Promise<{ status: string; sent: number; skipped: string[] }> {
    const s = tenantDb(this.db, t.schema);
    const record = (status: string, detail: string | null) =>
      s.updateTable('report_schedules').set({ last_run_at: now.toISOString(), last_status: status, last_detail: detail }).where('id', '=', sched.id).execute();
    if (!(await emailEnabled(this.db, { fresh: true }))) {
      await record('email_off', 'Email is switched off for the platform (Administration > Platform settings), so nothing was sent.');
      return { status: 'email_off', sent: 0, skipped: [] };
    }
    const key = sched.report_key as ReportKey;
    const people = await this.people(t, sched.recipients as string[]);
    const origin = (await webOrigin(this.db)).replace(/\/+$/, '');
    const period = SCHEDULE_PERIOD[sched.frequency];
    const brand = await this.branding?.forDocuments(t.id);
    let sent = 0;
    const skipped: string[] = [];
    for (const id of sched.recipients as string[]) {
      const p = people.get(id);
      if (!p || p.scope === undefined) {
        skipped.push(`${p?.name ?? 'A removed user'} can no longer open this customer`);
        continue;
      }
      try {
        const doc = await this.reports.build({ ...t, siteScope: p.scope }, p.role, key, { period }, now);
        const pdf = await renderReportPdf(doc, t.name, now, brand);
        const filename = `${reportFileName(doc, t.name)}.pdf`;
        const headline = doc.sections.find((x) => x.kind === 'headline');
        const context: ScheduledReportContext = {
          reportTitle: doc.title,
          customerName: t.name,
          periodLabel: reportPeriodLabel(doc.period),
          frequencyLabel: SCHEDULE_FREQUENCY_LABELS[sched.frequency],
          headline: headline?.kind === 'headline' ? headline.title : null,
          sentences: headline?.kind === 'headline' ? headline.sentences : [],
          summary: doc.summary,
          url: `${origin}/reports/${key}?period=${period}&customer=${t.id}`,
          filename,
        };
        await this.mail.enqueue({
          template: 'scheduled_report',
          to: { email: p.email, name: p.name },
          context: context as unknown as Record<string, unknown>,
          related: { type: 'report_schedule', id: sched.id },
          createdBy: triggeredBy,
          tenantId: t.id,
          attachments: [{ filename, contentType: 'application/pdf', content: pdf }],
        });
        sent++;
      } catch (e) {
        // A role that can't open this report any more (e.g. Managed Services switched off) is skipped, not failed.
        skipped.push(`${p.name}: ${(e as Error).message}`);
      }
    }
    const status = sent === 0 ? 'failed' : skipped.length ? 'partly_sent' : 'sent';
    await record(status, [`Sent to ${sent} ${sent === 1 ? 'person' : 'people'}.`, ...skipped].join(' ').slice(0, 1000));
    return { status, sent, skipped };
  }
}
