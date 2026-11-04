// Bug report "Bug Report Edit": the person who reported a bug may correct its description while it is New. Its place in triage
// (status, resolution note) and anyone else's report stay with administrators.
import { ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BugReportsService } from '../../../../apps/api/src/bug-reports/bug-reports.service';
import { seedUser, unused, useDb } from '../helpers';

const handle = useDb();
let svc: BugReportsService;
let reporter: Awaited<ReturnType<typeof seedUser>>;
let other: Awaited<ReturnType<typeof seedUser>>;
const actor = (u: { id: string; email: string; role: string }) => ({ id: u.id, email: u.email, role: u.role });
const base = { title: 'Cannot edit my report', area: 'other', severity: 'medium', steps_to_reproduce: 'Open a report I made', expected_behavior: 'Edit it', actual_behavior: 'No Edit button' } as never;

beforeAll(async () => {
  reporter = await seedUser(handle, 'ENGINEER');
  other = await seedUser(handle, 'ENGINEER');
  svc = new BugReportsService(handle.db, new AuditService(handle.db), unused('mail'), { WEB_ORIGIN: 'https://www.voxshift.io' } as never);
});

describe('editing a bug report', () => {
  it('lets the reporter change the description of their own New report', async () => {
    const bug = await svc.create(base, actor(reporter));
    const row = await svc.update(bug.id, { title: 'Cannot edit a report I made', actual_behavior: 'There is no Edit button' }, actor(reporter), false);
    expect(row).toMatchObject({ title: 'Cannot edit a report I made', actual_behavior: 'There is no Edit button', status: 'new' });
  });

  it("refuses someone else's report, the status and the resolution note", async () => {
    const bug = await svc.create(base, actor(reporter));
    await expect(svc.update(bug.id, { title: 'Someone else edits it' }, actor(other), false)).rejects.toThrow(ForbiddenException);
    await expect(svc.update(bug.id, { status: 'fixed' }, actor(reporter), false)).rejects.toThrow(/status/);
    await expect(svc.update(bug.id, { resolution_note: 'done' }, actor(reporter), false)).rejects.toThrow(/resolution_note/);
  });

  it('refuses the reporter once triage has started, and lets an administrator change anything', async () => {
    const bug = await svc.create(base, actor(reporter));
    await platformDb(handle.db).updateTable('bug_reports').set({ status: 'confirmed' }).where('id', '=', bug.id).execute();
    await expect(svc.update(bug.id, { title: 'Too late to change' }, actor(reporter), false)).rejects.toThrow(/already being worked on/);
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    expect(await svc.update(bug.id, { title: 'Changed by an administrator' }, actor(admin), true)).toMatchObject({ title: 'Changed by an administrator' });
  });
});
