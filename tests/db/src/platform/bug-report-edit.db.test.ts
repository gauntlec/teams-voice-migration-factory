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

describe('deleting a bug report', () => {
  it('lets the reporter withdraw their own New report, but not anyone else, and not once triage has started', async () => {
    const mine = await svc.create(base, actor(reporter));
    await expect(svc.remove(mine.id, actor(other), false)).rejects.toThrow(/Only the person who reported/);
    expect(await svc.remove(mine.id, actor(reporter), false)).toEqual({ ok: true });

    const started = await svc.create(base, actor(reporter));
    await platformDb(handle.db).updateTable('bug_reports').set({ status: 'confirmed' }).where('id', '=', started.id).execute();
    await expect(svc.remove(started.id, actor(reporter), false)).rejects.toThrow(/already being worked on/);
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    expect(await svc.remove(started.id, actor(admin), true)).toEqual({ ok: true });
  });
});

describe('attaching files to a bug report', () => {
  const pdf = (bytes = 64) => ({ originalname: 'Investigation report.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(bytes, 7), size: bytes });

  it('lets the reporter and an administrator attach, counts them on the board, and returns the same bytes', async () => {
    const bug = await svc.create(base, actor(reporter));
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    const mine = await svc.attach(bug.id, pdf(), actor(reporter), false);
    await platformDb(handle.db).updateTable('bug_reports').set({ status: 'confirmed' }).where('id', '=', bug.id).execute();
    await svc.attach(bug.id, pdf(128), actor(admin), true);
    expect((await svc.attachments(bug.id)).map((a) => [a.filename, a.size])).toEqual([['Investigation report.pdf', 64], ['Investigation report.pdf', 128]]);
    expect((await svc.list()).find((b) => b.id === bug.id)?.attachment_count).toBe(2);
    const file = await svc.attachment(bug.id, mine.id);
    expect(file.content.equals(Buffer.alloc(64, 7))).toBe(true);
  });

  it("refuses someone else's report, a file type it can't take, a file that is too large, and a file from another report", async () => {
    const bug = await svc.create(base, actor(reporter));
    await expect(svc.attach(bug.id, pdf(), actor(other), false)).rejects.toThrow(/Only the person who reported/);
    await expect(svc.attach(bug.id, { ...pdf(), mimetype: 'application/x-msdownload' }, actor(reporter), false)).rejects.toThrow(/can't be attached/);
    await expect(svc.attach(bug.id, { ...pdf(), size: 11 * 1024 * 1024 }, actor(reporter), false)).rejects.toThrow(/too large/);
    const a = await svc.attach(bug.id, pdf(), actor(reporter), false);
    const otherBug = await svc.create(base, actor(reporter));
    await expect(svc.attachment(otherBug.id, a.id)).rejects.toThrow(/not found/);
  });

  it('lets whoever attached a file, or an administrator, remove it', async () => {
    const bug = await svc.create(base, actor(reporter));
    const a = await svc.attach(bug.id, pdf(), actor(reporter), false);
    await expect(svc.removeAttachment(bug.id, a.id, actor(other), false)).rejects.toThrow(/Only whoever attached/);
    expect(await svc.removeAttachment(bug.id, a.id, actor(reporter), false)).toEqual({ ok: true });
    expect(await svc.attachments(bug.id)).toEqual([]);
  });
});
