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
