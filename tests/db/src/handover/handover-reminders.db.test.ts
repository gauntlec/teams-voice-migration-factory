// docs/HANDOVER-VIEW.md step 4: an outstanding action still open after the customer's reminder interval is overdue. The site's Provider
// PM(s) and whoever generated its newest pack get one email per customer listing theirs (an all-sites action goes to every site's
// people), each action at most once per interval, and the overdue count is on the menu and the site rows even with email off.
import { platformDb } from '@tvmf/db';
import type { HandoverActionsReminderContext } from '@tvmf/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { HandoverDocumentService } from '../../../../apps/api/src/modules/handover/handover-document.service';
import { HandoverService } from '../../../../apps/api/src/modules/handover/handover.service';
import { sweepHandoverReminders } from '../../../../apps/worker/src/handover-reminders';
import type { MailEnqueuer } from '../../../../apps/worker/src/mail/enqueue';
import { seedCustomer, seedSite, seedUser, useDb } from '../helpers';

const handle = useDb();
let svc: HandoverService;

beforeAll(() => {
  const mem = new Map<string, Buffer>();
  const storage = {
    write: async (p: string, d: Buffer) => void mem.set(p, d),
    read: async (p: string) => mem.get(p)!,
    delete: async (p: string) => void mem.delete(p),
    exists: async (p: string) => mem.has(p),
    deleteFolder: async () => {},
    folderStats: async () => ({ files: 0, bytes: 0 }),
  };
  svc = new HandoverService(handle.db, new FilesService(handle.db, storage), new HandoverDocumentService(), new AuditService(handle.db));
});

const DAY = 86_400_000;

describe('Service Handover reminders', () => {
  it('emails each Provider PM and pack author once about their overdue actions, and counts them for the menu', async () => {
    const d = await seedCustomer(handle);
    const engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
    const pm = await seedUser(handle, 'PROJECT_MANAGER', { displayName: 'Pam Manager' });
    const man = (await seedSite(d.s, { sitecode: 'MAN01', name: 'Manchester' })).id;
    const gla = (await seedSite(d.s, { sitecode: 'GLA01', name: 'Glasgow' })).id;
    await d.s.updateTable('discovery_sites').set({ overview: { contacts: { providerPm: [{ userId: pm.id }, { name: 'Typed PM', email: 'typed.pm@contoso.test' }] } } } as never).where('id', '=', man).execute();
    // Glasgow has no Provider PM: its pack's author is told
    await svc.generate(d.t, engineer, { siteIds: [gla] });

    const action = async (siteId: string | null, description: string, daysAgo: number, done = false) => {
      const a = await svc.createAction(d.t, engineer, { siteId, description, owner: 'Provider' });
      await d.s.updateTable('handover_actions').set({ created_at: new Date(Date.now() - daysAgo * DAY).toISOString() } as never).where('id', '=', a.id).execute();
      if (done) await svc.updateAction(d.t, engineer, a.id, { done: true });
      return a.id;
    };
    await action(man, 'Test 999 on the lobby phone', 10);
    await action(man, 'Label the new handsets', 2); // not overdue yet
    await action(gla, 'Retire the old PBX', 8);
    await action(null, 'Hand over the admin guide', 9);
    await action(man, 'Done long ago', 30, true);

    expect(await svc.overdue(d.t)).toEqual({ reminderDays: 7, overdue: 3 });
    const rows = await svc.sites(d.t, engineer);
    expect(rows.find((r) => r.sitecode === 'MAN01')!.actions).toEqual({ open: 3, total: 4, overdue: 2 });
    expect((await svc.listActions(d.t, man)).filter((a) => a.overdue).map((a) => a.description).sort()).toEqual(['Hand over the admin guide', 'Test 999 on the lobby phone']);

    const sent: { to: { email: string }; context: HandoverActionsReminderContext }[] = [];
    const enqueue: MailEnqueuer = async (m) => void sent.push(m as never);
    expect(await sweepHandoverReminders(handle.db, enqueue, { tenantId: d.t.id })).toEqual({ emails: 3, actions: 3 });
    const forEmail = (email: string) => sent.find((m) => m.to.email === email)!.context;
    const listed = (c: HandoverActionsReminderContext) => c.sites.map((s) => [s.sitecode, s.actions.map((a) => a.description)]);

    expect(listed(forEmail(pm.email))).toEqual([
      ['MAN01', ['Test 999 on the lobby phone']],
      [null, ['Hand over the admin guide']],
    ]);
    expect(listed(forEmail('typed.pm@contoso.test'))).toEqual(listed(forEmail(pm.email)));
    expect(listed(forEmail(engineer.email))).toEqual([
      ['GLA01', ['Retire the old PBX']],
      [null, ['Hand over the admin guide']],
    ]);
    expect(forEmail(pm.email)).toMatchObject({ recipientName: 'Pam Manager', days: 7 });
    expect(forEmail(pm.email).sites[0]!.actions[0]!.daysOpen).toBe(10);
    expect(forEmail(pm.email).sites[0]!.url).toMatch(new RegExp(`/handover/sites/${man}$`));

    // not again until the interval has passed since the last reminder
    sent.length = 0;
    expect(await sweepHandoverReminders(handle.db, enqueue, { tenantId: d.t.id })).toEqual({ emails: 0, actions: 0 });
    expect(await sweepHandoverReminders(handle.db, enqueue, { tenantId: d.t.id, now: new Date(Date.now() + 7 * DAY) })).toMatchObject({ emails: 3 });
    // the action that was 2 days old is overdue by then too
    expect(listed(sent.find((m) => m.to.email === pm.email)!.context)[0]).toEqual(['MAN01', ['Test 999 on the lobby phone', 'Label the new handsets']]);

    // switched off: no emails, nothing overdue
    await svc.setReminderDays(d.t, engineer, 0);
    expect(await svc.overdue(d.t)).toEqual({ reminderDays: 0, overdue: 0 });
    expect(await sweepHandoverReminders(handle.db, enqueue, { tenantId: d.t.id, now: new Date(Date.now() + 30 * DAY) })).toEqual({ emails: 0, actions: 0 });
    expect((await svc.listActions(d.t)).some((a) => a.overdue)).toBe(false);
    await expect(svc.setReminderDays(d.t, engineer, 400)).rejects.toThrow(/0 to 365/);
    expect((await platformDb(handle.db).selectFrom('tenants').select('handover_reminder_days').where('id', '=', d.t.id).executeTakeFirstOrThrow()).handover_reminder_days).toBe(0);
  });

  it('keeps an action due when there is nobody to tell, so it is reminded once someone is', async () => {
    const d = await seedCustomer(handle);
    const engineer = await seedUser(handle, 'ENGINEER');
    const site = (await seedSite(d.s, { sitecode: 'EDI01' })).id;
    const a = await svc.createAction(d.t, engineer, { siteId: site, description: 'Check the paging zone' });
    await d.s.updateTable('handover_actions').set({ created_at: new Date(Date.now() - 20 * DAY).toISOString() } as never).where('id', '=', a.id).execute();
    const sent: unknown[] = [];
    const enqueue: MailEnqueuer = async (m) => void sent.push(m as never);
    expect(await sweepHandoverReminders(handle.db, enqueue, { tenantId: d.t.id })).toEqual({ emails: 0, actions: 0 });
    await svc.generate(d.t, engineer, { siteIds: [site] });
    expect(await sweepHandoverReminders(handle.db, enqueue, { tenantId: d.t.id })).toEqual({ emails: 1, actions: 1 });
  });
});

describe('the reminder email', () => {
  it('lists each site’s actions and how long they have been open, and links to the site', async () => {
    const { renderEmail } = await import('../../../../apps/worker/src/mail/templates');
    const context: HandoverActionsReminderContext = {
      recipientName: 'Pam Manager',
      customerName: 'Contoso',
      days: 7,
      listUrl: 'https://example.test/handover',
      sites: [
        { sitecode: 'MAN01', siteName: 'Manchester', url: 'https://example.test/handover/sites/s1', actions: [{ description: 'Test 999 on the lobby phone', owner: 'Provider', daysOpen: 10 }] },
        { sitecode: null, siteName: null, url: 'https://example.test/handover', actions: [{ description: 'Hand over the admin guide', owner: '', daysOpen: 1 }] },
      ],
    };
    const mail = renderEmail('handover_actions_reminder', context as never);
    expect(mail.subject).toBe('Reminder: 2 handover actions still open — Manchester');
    for (const t of ['Hello Pam Manager', 'open more than 7 days', 'MAN01 Manchester:', '• Test 999 on the lobby phone (Provider), open 10 days', 'All sites:', '• Hand over the admin guide, open 1 day', 'https://example.test/handover/sites/s1'])
      expect(mail.text).toContain(t);
  });
});
