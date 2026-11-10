// Bug report "Feature Requests": the person who asked for a feature may change or withdraw it while it is New. Its place on the board
// and the decision note stay with administrators, as on the bug board.
import { ForbiddenException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { FeatureRequestsService } from '../../../../apps/api/src/feature-requests/feature-requests.service';
import { seedUser, unused, useDb } from '../helpers';

const handle = useDb();
let svc: FeatureRequestsService;
let requester: Awaited<ReturnType<typeof seedUser>>;
let other: Awaited<ReturnType<typeof seedUser>>;
const actor = (u: { id: string; email: string; role: string }) => ({ id: u.id, email: u.email, role: u.role });
const base = {
  title: 'Show which users get a phone',
  area: 'site_data',
  priority: 'medium',
  problem: 'Nobody can see which users were given a physical phone.',
  proposal: 'A list of users with phones, in Site Data and Design & Build.',
  affected_roles: [],
} as never;

beforeAll(async () => {
  requester = await seedUser(handle, 'ENGINEER');
  other = await seedUser(handle, 'ENGINEER');
  svc = new FeatureRequestsService(handle.db, new AuditService(handle.db), unused('mail'), { WEB_ORIGIN: 'https://www.voxshift.io' } as never);
});

describe('changing a feature request', () => {
  it('lets the requester change their own New request', async () => {
    const f = await svc.create(base, actor(requester));
    expect(await svc.update(f.id, { title: 'Show who has a physical phone' }, actor(requester), false)).toMatchObject({ title: 'Show who has a physical phone', status: 'new' });
  });

  it("refuses someone else's request, the status and the decision note", async () => {
    const f = await svc.create(base, actor(requester));
    await expect(svc.update(f.id, { title: 'Someone else edits it' }, actor(other), false)).rejects.toThrow(ForbiddenException);
    await expect(svc.update(f.id, { status: 'under_review' } as never, actor(requester), false)).rejects.toThrow(/status/);
    await expect(svc.update(f.id, { decision_note: 'yes' }, actor(requester), false)).rejects.toThrow(/decision_note/);
  });

  it('refuses the requester once it has been picked up, and lets an administrator change anything', async () => {
    const f = await svc.create(base, actor(requester));
    await platformDb(handle.db).updateTable('feature_requests').set({ status: 'under_review' } as never).where('id', '=', f.id).execute();
    await expect(svc.update(f.id, { title: 'Too late to change' }, actor(requester), false)).rejects.toThrow(/already been picked up/);
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    expect(await svc.update(f.id, { title: 'Changed by an administrator' }, actor(admin), true)).toMatchObject({ title: 'Changed by an administrator' });
  });
});

describe('withdrawing a feature request', () => {
  it('lets the requester delete their own New request, but not anyone else, and not once picked up', async () => {
    const f = await svc.create(base, actor(requester));
    await expect(svc.remove(f.id, actor(other), false)).rejects.toThrow(/Only the person who asked/);
    expect(await svc.remove(f.id, actor(requester), false)).toEqual({ ok: true });

    const picked = await svc.create(base, actor(requester));
    await platformDb(handle.db).updateTable('feature_requests').set({ status: 'under_review' } as never).where('id', '=', picked.id).execute();
    await expect(svc.remove(picked.id, actor(requester), false)).rejects.toThrow(/already been picked up/);
  });
});

describe('attaching files to a feature request', () => {
  const pdf = (bytes = 64) => ({ originalname: 'Mock-up.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(bytes, 7), size: bytes });

  it('lets the requester and an administrator attach, counts them on the board, and returns the same bytes', async () => {
    const f = await svc.create(base, actor(requester));
    const admin = await seedUser(handle, 'SUPER_ADMIN');
    const mine = await svc.attach(f.id, pdf(), actor(requester), false);
    expect(mine).toMatchObject({ filename: 'Mock-up.pdf', content_type: 'application/pdf', size: 64, uploaded_by: requester.id });
    await svc.attach(f.id, pdf(128), actor(admin), true);
    expect((await svc.attachments(f.id)).map((a) => [a.filename, a.size])).toEqual([['Mock-up.pdf', 64], ['Mock-up.pdf', 128]]);
    expect((await svc.list()).find((x) => x.id === f.id)?.attachment_count).toBe(2);
    const file = await svc.attachment(f.id, mine.id);
    expect(Buffer.from(file.content).equals(Buffer.alloc(64, 7))).toBe(true);
    // still allowed once the request is being worked on
    await platformDb(handle.db).updateTable('feature_requests').set({ status: 'under_review' }).where('id', '=', f.id).execute();
    await svc.attach(f.id, pdf(), actor(requester), false);
  });

  it('refuses someone else, a kind of file it can’t take, a file too large, and a file from another request', async () => {
    const f = await svc.create(base, actor(requester));
    const otherRequest = await svc.create(base, actor(requester));
    await expect(svc.attach(f.id, pdf(), actor(other), false)).rejects.toThrow(/Only the person who asked/);
    await expect(svc.attach(f.id, { ...pdf(), mimetype: 'application/x-msdownload' }, actor(requester), false)).rejects.toThrow(/can't be attached/);
    await expect(svc.attach(f.id, { ...pdf(), size: 11 * 1024 * 1024 }, actor(requester), false)).rejects.toThrow(/too large/);
    const a = await svc.attach(f.id, pdf(), actor(requester), false);
    await expect(svc.attachment(otherRequest.id, a.id)).rejects.toThrow(/not found/);
  });

  it('lets whoever attached a file, or an administrator, remove it, and removes files with their request', async () => {
    const f = await svc.create(base, actor(requester));
    const a = await svc.attach(f.id, pdf(), actor(requester), false);
    await expect(svc.removeAttachment(f.id, a.id, actor(other), false)).rejects.toThrow(/Only whoever attached/);
    expect(await svc.removeAttachment(f.id, a.id, actor(requester), false)).toEqual({ ok: true });
    expect(await svc.attachments(f.id)).toEqual([]);

    const b = await svc.attach(f.id, pdf(), actor(requester), false);
    await svc.remove(f.id, actor(requester), false);
    expect(await platformDb(handle.db).selectFrom('feature_request_attachments').select('id').where('id', '=', b.id).execute()).toEqual([]);
  });
});
