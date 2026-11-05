// Scheduled reports (docs/INSIGHTS.md, step 4b): a schedule only names people who can open the customer and reports the
// customer has; when it is due, every person gets their own copy built as them (role and sites), with the PDF attached and
// kept with the email; someone who lost access is skipped; nothing is sent while email is switched off.
import { beforeAll, describe, expect, it } from 'vitest';
import { forgetAppSettings, platformDb } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { IncidentReportService } from '../../../../apps/api/src/modules/incidents/incident-report.service';
import { InsightsAssistantsService } from '../../../../apps/api/src/modules/insights/insights-assistants.service';
import { InsightsReportsService } from '../../../../apps/api/src/modules/insights/insights-reports.service';
import { InsightsScheduleService } from '../../../../apps/api/src/modules/insights/insights-schedule.service';
import { InsightsService } from '../../../../apps/api/src/modules/insights/insights.service';
import { ProgressService } from '../../../../apps/api/src/modules/progress/progress.service';
import { MailService } from '../../../../apps/api/src/mail/mail.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, useGlobalSettingsLock, type TestCustomer } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
const db = platformDb(handle.db);
let c: TestCustomer;
let svc: InsightsScheduleService;
let admin: Awaited<ReturnType<typeof seedUser>>;
let pm: Awaited<ReturnType<typeof seedUser>>;
let contact: Awaited<ReturnType<typeof seedUser>>;
let outsider: Awaited<ReturnType<typeof seedUser>>;
let lon: string;
const now = new Date('2026-11-05T09:00:00Z');

const setEmail = async (on: boolean) => {
  await db.insertInto('app_settings').values({ id: true, email_enabled: on, base_url: null }).onConflict((oc) => oc.column('id').doUpdateSet({ email_enabled: on })).execute();
  forgetAppSettings();
};

beforeAll(async () => {
  await setEmail(true);
  c = await seedCustomer(handle, { managedServices: true });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Ada Admin' });
  pm = await seedUser(handle, 'PROJECT_MANAGER', { displayName: 'Pat Manager' });
  contact = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Contact' });
  outsider = await seedUser(handle, 'ENGINEER', { displayName: 'Oscar Outsider' });
  lon = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  await seedSite(c.s, { sitecode: 'NYC01' });
  await db.insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: pm.id } as never).execute();
  await db.insertInto('tenant_memberships').values({ tenant_id: c.t.id, user_id: contact.id, site_ids: [lon] } as never).execute();

  const audit = new AuditService(handle.db);
  const build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  const requests = { report: async () => ({ raised: 0, deployed: 0, completedBy: { assistants: 0, people: 0 }, openBacklog: { total: 0, under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 }, medianHoursToDeploy: null, resolutionMetPct: null, responseMetPct: null, responseMeasured: 0, resolutionMeasured: 0, byType: {}, byStatus: {} }) };
  const incidents = new IncidentReportService(handle.db);
  const insights = new InsightsService(handle.db, new ProgressService(handle.db, build), incidents, requests as never);
  const reports = new InsightsReportsService(handle.db, insights, incidents, requests as never, new InsightsAssistantsService(handle.db));
  svc = new InsightsScheduleService(handle.db, reports, new MailService(handle.db, { add: async () => undefined } as never), audit);
});

describe('scheduled reports', () => {
  it('offers only people who can open the customer, and refuses anyone else or a report the customer doesn’t have', async () => {
    const people = (await svc.candidates(c.t)).map((p) => p.name);
    expect(people).toEqual(expect.arrayContaining(['Ada Admin', 'Pat Manager', 'Cara Contact']));
    expect(people).not.toContain('Oscar Outsider');
    await expect(svc.create(c.t, admin, { reportKey: 'executive', frequency: 'monthly', recipients: [outsider.id] }, now)).rejects.toThrow(/people who can open this customer/);
    // Monitoring isn't on for this customer, so there is no Device status report.
    await expect(svc.create(c.t, admin, { reportKey: 'devices', frequency: 'monthly', recipients: [pm.id] }, now)).rejects.toThrow(/isn’t available/);
  });

  it('sends each person their own copy with the PDF attached, and skips someone who lost access', async () => {
    const sched = await svc.create(c.t, pm, { reportKey: 'executive', frequency: 'monthly', recipients: [pm.id, contact.id, admin.id] }, now);
    expect(sched).toMatchObject({ reportTitle: 'Executive summary', nextRunAt: '2026-12-01T07:00:00.000Z', createdBy: 'Pat Manager' });

    // Not due yet; then due.
    expect(await svc.tick(now)).toBe(0);
    await db.updateTable('users').set({ status: 'disabled' } as never).where('id', '=', admin.id).execute();
    expect(await svc.tick(new Date('2026-12-01T07:05:00Z'))).toBe(1);

    const [after] = await svc.list(c.t);
    expect(after).toMatchObject({ lastStatus: 'partly_sent', nextRunAt: '2027-01-01T07:00:00.000Z' });
    expect(after!.lastDetail).toMatch(/^Sent to 2 people\. Ada Admin can no longer open this customer/);
    expect(after!.recipients.find((r) => r.id === admin.id)).toMatchObject({ ok: false });

    const mails = await db
      .selectFrom('email_messages as m')
      .innerJoin('email_attachments as a', 'a.message_id', 'm.id')
      .select(['m.to_email', 'm.template', 'm.context', 'm.tenant_id', 'a.filename', 'a.content_type', 'a.content'])
      .where('m.related_id', '=', sched.id)
      .execute();
    expect(mails.map((m) => m.to_email).sort()).toEqual([contact.email, pm.email].sort());
    for (const m of mails) {
      expect(m).toMatchObject({ template: 'scheduled_report', tenant_id: c.t.id, content_type: 'application/pdf' });
      expect(m.filename).toMatch(/^voxshift-executive-.+-2026-11-01-to-2026-11-30\.pdf$/);
      expect((m.content as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(m.context).toMatchObject({ reportTitle: 'Executive summary', periodLabel: '1 Nov – 30 Nov 2026', frequencyLabel: 'Monthly' });
      expect((m.context as { url: string }).url).toMatch(new RegExp(`/reports/executive\\?period=last_month&customer=${c.t.id}$`));
    }
    // The site contact's copy covers their own site only.
    const contactCopy = mails.find((m) => m.to_email === contact.email)!;
    expect((contactCopy.context as { headline: string }).headline).toMatch(/^0 of 1 site live/);
    await db.updateTable('users').set({ status: 'active' } as never).where('id', '=', admin.id).execute();
  });

  it('sends nothing while email is switched off, and says so', async () => {
    const [sched] = await svc.list(c.t);
    await setEmail(false);
    try {
      expect(await svc.sendNow(c.t, pm, sched!.id, now)).toEqual({ status: 'email_off', sent: 0, skipped: [] });
      expect((await svc.list(c.t))[0]).toMatchObject({ lastStatus: 'email_off', nextRunAt: '2027-01-01T07:00:00.000Z' });
    } finally {
      await setEmail(true);
    }
  });

  it('changes and deletes a schedule; a new frequency moves the next send', async () => {
    const [sched] = await svc.list(c.t);
    const changed = await svc.update(c.t, pm, sched!.id, { reportKey: 'migration', frequency: 'quarterly', recipients: [pm.id], enabled: false }, now);
    expect(changed).toMatchObject({ reportKey: 'migration', frequency: 'quarterly', enabled: false, nextRunAt: '2027-01-01T07:00:00.000Z' });
    expect(await svc.tick(new Date('2027-01-01T08:00:00Z'))).toBe(0); // switched off
    await svc.remove(c.t, pm, sched!.id);
    expect(await svc.list(c.t)).toEqual([]);
    const audit = await c.s.selectFrom('audit_log').select('action').where('action', 'like', 'insights.schedule_%').orderBy('at').execute();
    expect(audit.map((a) => a.action)).toEqual(['insights.schedule_created', 'insights.schedule_sent_now', 'insights.schedule_updated', 'insights.schedule_deleted']);
  });
});

describe('Reports › Sent (step 6b)', () => {
  it('lists every copy sent for the customer, newest first, with the PDF while it is kept', async () => {
    const sched = (await svc.list(c.t))[0];
    if (sched) await svc.sendNow(c.t, pm, sched.id, now);
    const sent = await svc.sent(c.t);
    expect(sent.length).toBeGreaterThan(0);
    const first = sent[0]!;
    expect(first).toMatchObject({ status: 'queued', reportTitle: expect.any(String), pdf: { filename: expect.stringMatching(/\.pdf$/) } });
    expect(first.path).toMatch(/^\/reports\/[a-z-]+\?period=last_(month|quarter)&customer=/);
    expect(sent.map((x) => x.at)).toEqual([...sent.map((x) => x.at)].sort().reverse());
    const pdf = await svc.sentPdf(c.t, first.id);
    expect(pdf.content.subarray(0, 5).toString()).toBe('%PDF-');

    // another customer can't read it, and once the PDF is no longer kept it says so
    const other = await seedCustomer(handle, { name: 'Elsewhere' });
    await expect(svc.sentPdf(other.t, first.id)).rejects.toThrow('No such report');
    expect(await svc.sent(other.t)).toEqual([]);
    await db.updateTable('email_attachments').set({ content: null }).where('message_id', '=', first.id).execute();
    await expect(svc.sentPdf(c.t, first.id)).rejects.toThrow('kept for 90 days');
    expect((await svc.sent(c.t)).find((x) => x.id === first.id)!.pdf).toBeNull();
  });
});
