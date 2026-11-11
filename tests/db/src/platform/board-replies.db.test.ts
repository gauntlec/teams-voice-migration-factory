// Replies on Bug reports and Feature requests cards (0045): anyone who can see the board replies, the thread reads oldest first with its
// files, the card counts its replies, the people following the card are emailed, and only the author or an administrator deletes a reply.
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BugReportsService } from '../../../../apps/api/src/bug-reports/bug-reports.service';
import { FeatureRequestsService } from '../../../../apps/api/src/feature-requests/feature-requests.service';
import type { EnqueueMailInput } from '../../../../apps/api/src/mail/mail.service';
import { seedUser, useDb } from '../helpers';

const handle = useDb();
const sent: EnqueueMailInput[] = [];
const mail = { enqueue: async (m: EnqueueMailInput) => (sent.push(m), { id: null }) } as never;
const cfg = { WEB_ORIGIN: 'https://www.voxshift.io' } as never;
let bugs: BugReportsService;
let features: FeatureRequestsService;
type U = Awaited<ReturnType<typeof seedUser>>;
let reporter: U;
let engineer: U;
let admin: U;
const actor = (u: U) => ({ id: u.id, email: u.email, role: u.role });
const pdf = (bytes = 32) => ({ originalname: 'Answers.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(bytes, 5), size: bytes });
const bug = { title: 'Numbers missing', area: 'Other', severity: 'medium', steps_to_reproduce: 'Open a site', expected_behavior: 'Numbers', actual_behavior: 'None' } as never;
const feature = { title: 'Handover view', area: 'Service Handover', priority: 'medium', problem: 'No overview.', proposal: 'A view.', affected_roles: [] } as never;
const recipients = () => sent.map((m) => [m.to.email, (m.context as { reason: string }).reason]).sort();

beforeAll(async () => {
  reporter = await seedUser(handle, 'ENGINEER', { displayName: 'Reporter' });
  engineer = await seedUser(handle, 'PROJECT_MANAGER', { displayName: 'Another engineer' });
  admin = await seedUser(handle, 'SUPER_ADMIN', { displayName: 'Admin' });
  bugs = new BugReportsService(handle.db, new AuditService(handle.db), mail, cfg);
  features = new FeatureRequestsService(handle.db, new AuditService(handle.db), mail, cfg);
});
beforeEach(() => {
  sent.length = 0;
});

describe('replying on a bug report', () => {
  it('lists replies oldest first with their authors and files, and counts them on the card', async () => {
    const b = await bugs.create(bug, actor(reporter));
    await bugs.addReply(b.id, { body: 'Which site?' }, undefined, actor(admin));
    const answer = await bugs.addReply(b.id, { body: 'Glasgow.\nAll of them.' }, pdf(), actor(reporter));
    expect(answer).toMatchObject({ body: 'Glasgow.\nAll of them.', author_id: reporter.id, author_name: 'Reporter', attachments: [{ filename: 'Answers.pdf', size: 32 }] });

    const thread = await bugs.listReplies(b.id);
    expect(thread.map((r) => [r.author_name, r.body, r.attachments.map((a) => a.filename)])).toEqual([
      ['Admin', 'Which site?', []],
      ['Reporter', 'Glasgow.\nAll of them.', ['Answers.pdf']],
    ]);

    const card = (await bugs.list()).find((x) => x.id === b.id)!;
    expect(card).toMatchObject({ reply_count: 2, last_reply_by: reporter.id, attachment_count: 0 });
    expect(card.last_reply_at).toBeTruthy();
    // a reply's file is listed under the reply, not with the card's own files, but downloads from the card's route
    expect(await bugs.attachments(b.id)).toEqual([]);
    const file = await bugs.attachment(b.id, answer.attachments[0].id);
    expect(Buffer.from(file.content).equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it('lets anyone who can see the board reply, at any stage', async () => {
    const b = await bugs.create(bug, actor(reporter));
    await platformDb(handle.db).updateTable('bug_reports').set({ status: 'deployed' }).where('id', '=', b.id).execute();
    expect(await bugs.addReply(b.id, { body: 'Still happens for me.' }, undefined, actor(engineer))).toMatchObject({ author_name: 'Another engineer' });
  });

  it('refuses a file the boards do not take, and saves nothing', async () => {
    const b = await bugs.create(bug, actor(reporter));
    await expect(bugs.addReply(b.id, { body: 'Here' }, { ...pdf(), mimetype: 'application/x-msdownload' }, actor(reporter))).rejects.toThrow(BadRequestException);
    expect(await bugs.listReplies(b.id)).toEqual([]);
  });

  it('refuses a card that does not exist', async () => {
    await expect(bugs.addReply('00000000-0000-4000-8000-000000000000', { body: 'Hello' }, undefined, actor(reporter))).rejects.toThrow(NotFoundException);
  });

  it('lets the author or an administrator delete a reply, taking its file with it', async () => {
    const b = await bugs.create(bug, actor(reporter));
    const mine = await bugs.addReply(b.id, { body: 'Mine' }, pdf(), actor(reporter));
    await expect(bugs.removeReply(b.id, mine.id, actor(engineer), false)).rejects.toThrow(ForbiddenException);
    expect(await bugs.removeReply(b.id, mine.id, actor(reporter), false)).toEqual({ ok: true });
    const files = await platformDb(handle.db).selectFrom('bug_report_attachments').select('id').where('bug_report_id', '=', b.id).execute();
    expect(files).toEqual([]);

    const theirs = await bugs.addReply(b.id, { body: 'Theirs' }, undefined, actor(engineer));
    expect(await bugs.removeReply(b.id, theirs.id, actor(admin), true)).toEqual({ ok: true });
    expect(await bugs.listReplies(b.id)).toEqual([]);
  });

  it("emails the card's owner, the others in the thread and whoever moved the card - never the author", async () => {
    const b = await bugs.create(bug, actor(reporter));
    await bugs.update(b.id, { status: 'confirmed' }, actor(admin), true);
    sent.length = 0;

    // the reporter answers: the administrator who moved the card hears about it
    await bugs.addReply(b.id, { body: 'It is every site.' }, undefined, actor(reporter));
    expect(recipients()).toEqual([[admin.email, 'worker']]);
    expect(sent[0]).toMatchObject({ template: 'board_reply', related: { type: 'bug_report', id: b.id } });
    expect(sent[0].context).toMatchObject({ board: 'bug', title: 'Numbers missing', author: 'Reporter', body: 'It is every site.', runUrl: 'https://www.voxshift.io/bug-reports' });

    // another engineer joins in: the owner and the administrator
    sent.length = 0;
    await bugs.addReply(b.id, { body: 'Same here.' }, undefined, actor(engineer));
    expect(recipients()).toEqual([[admin.email, 'worker'], [reporter.email, 'owner']].sort());

    // a disabled account is not emailed
    await platformDb(handle.db).updateTable('users').set({ status: 'disabled' }).where('id', '=', engineer.id).execute();
    sent.length = 0;
    await bugs.addReply(b.id, { body: 'Fixed in the next release.' }, undefined, actor(admin));
    expect(recipients()).toEqual([[reporter.email, 'owner']]);
    await platformDb(handle.db).updateTable('users').set({ status: 'active' }).where('id', '=', engineer.id).execute();
  });
});

describe('replying on a feature request', () => {
  it('keeps its own thread, counts it on the card and emails the requester', async () => {
    const f = await features.create(feature, actor(reporter));
    await features.addReply(f.id, { body: '1. Yes\n2. Per site' }, pdf(), actor(admin));
    expect(recipients()).toEqual([[reporter.email, 'owner']]);
    expect(sent[0].context).toMatchObject({ board: 'feature', attachments: ['Answers.pdf'], runUrl: 'https://www.voxshift.io/feature-requests' });

    const card = (await features.list()).find((x) => x.id === f.id)!;
    expect(card).toMatchObject({ reply_count: 1, last_reply_by: admin.id, attachment_count: 0 });
    expect((await features.listReplies(f.id)).map((r) => r.body)).toEqual(['1. Yes\n2. Per site']);
    expect(await features.attachments(f.id)).toEqual([]);

    // a bug report's reply id does not reach a feature request's thread
    const b = await bugs.create(bug, actor(reporter));
    const r = await bugs.addReply(b.id, { body: 'On a bug' }, undefined, actor(reporter));
    await expect(features.removeReply(f.id, r.id, actor(admin), true)).rejects.toThrow(NotFoundException);
  });

  it('goes with its card', async () => {
    const f = await features.create(feature, actor(reporter));
    await features.addReply(f.id, { body: 'Bye' }, pdf(), actor(reporter));
    await features.remove(f.id, actor(admin), true);
    const left = await platformDb(handle.db).selectFrom('feature_request_replies').select('id').where('feature_request_id', '=', f.id).execute();
    expect(left).toEqual([]);
  });
});
