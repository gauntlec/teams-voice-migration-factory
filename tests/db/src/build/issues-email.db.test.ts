// An engineer picks issues on the Validation issues tab and emails them to the site's contacts. Only what is still an issue goes, in the
// tab's own words, whatever the caller sent.
import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { MailService } from '../../../../apps/api/src/mail/mail.service';
import { BuildIssuesEmailService } from '../../../../apps/api/src/modules/build/build-issues-email.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: BuildIssuesEmailService;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;
let emptySiteId: string;
let ghostRow: string;
const queued: { to: string; context: Record<string, unknown> }[] = [];

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  const audit = new AuditService(handle.db);
  build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  const mail = new MailService(handle.db, { add: async (_name: string, data: { messageId: string }) => void queued.push({ to: data.messageId, context: {} }) } as never);
  svc = new BuildIssuesEmailService(handle.db, audit, build, mail);
  siteId = (await seedSite(c.s, { sitecode: 'BOS01' })).id;
  emptySiteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  await c.s.updateTable('discovery_sites').set({ name: 'Boston', overview: JSON.stringify({ contacts: { siteContacts: [{ name: 'Pat', email: 'pat@contoso.test' }, { name: 'Lee', email: 'lee@contoso.test' }] } }) } as never).where('id', '=', siteId).execute();
  ghostRow = (await c.s.insertInto('build_users').values({ site_id: siteId, upn: 'ghost@contoso.test', number_type: 'CallingPlan', policies: {} } as never).returning('id').executeTakeFirstOrThrow()).id;
});

const emails = () => handle.db.selectFrom('platform.email_messages' as never).selectAll().where('template' as never, '=', 'validation_issues_alert' as never).execute();

describe('emailing validation issues to site contacts', () => {
  it('lists the site contacts it would send to, and refuses a site that has none', async () => {
    expect((await svc.recipients(c.t, siteId)).map((r) => r.email).sort()).toEqual(['lee@contoso.test', 'pat@contoso.test']);
    await expect(svc.send(c.t, engineer, { site_id: emptySiteId, issues: [{ sheet: 'users', row_id: ghostRow, code: 'not_in_tenant', detail: 'x' }] } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends one email per contact with the picked issues as the tab words them', async () => {
    const issue = (await build.siteIssues(c.t, siteId)).find((i) => i.rowId === ghostRow && i.issue.code === 'not_in_tenant')!;
    const before = (await emails()).length;
    const res = await svc.send(c.t, engineer, { site_id: siteId, issues: [{ sheet: 'users', row_id: ghostRow, code: 'not_in_tenant', detail: issue.issue.detail }], message: 'Please check these.' } as never);
    expect(res).toEqual({ sent: 2, issues: 1, skipped: 0 });
    const rows = (await emails()).slice(before) as unknown as { to_email: string; context: { issues: { upn: string; label: string }[]; message: string; senderName: string } }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.context.issues).toMatchObject([{ upn: 'ghost@contoso.test', label: 'Not in tenant' }]);
    expect(rows[0]!.context).toMatchObject({ message: 'Please check these.', senderName: engineer.displayName });
  });

  it('can be narrowed to some contacts, and sends nothing for an issue that is not there, whatever the caller wrote', async () => {
    const issue = (await build.siteIssues(c.t, siteId)).find((i) => i.rowId === ghostRow)!;
    const one = await svc.send(c.t, engineer, { site_id: siteId, issues: [{ sheet: 'users', row_id: ghostRow, code: 'not_in_tenant', detail: issue.issue.detail }], recipients: ['lee@contoso.test'] } as never);
    expect(one.sent).toBe(1);
    await expect(svc.send(c.t, engineer, { site_id: siteId, issues: [{ sheet: 'users', row_id: ghostRow, code: 'not_in_tenant', detail: 'Made up wording' }] } as never)).rejects.toBeInstanceOf(ConflictException);
  });
});
