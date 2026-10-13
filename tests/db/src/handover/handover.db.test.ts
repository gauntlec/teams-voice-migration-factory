// Service Handover: what the pack says, and who may see it. Drafts are for
// Voxshift staff only; customers see a pack once it's issued, without the
// internal note, and the issued document must not still say DRAFT.
import { NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { HandoverDocumentService } from '../../../../apps/api/src/modules/handover/handover-document.service';
import { HandoverService } from '../../../../apps/api/src/modules/handover/handover.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let files: FilesService;
let svc: HandoverService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let customer: Awaited<ReturnType<typeof seedUser>>;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  customer = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  const site = await seedSite(c.s, { sitecode: 'LON01' });
  const policy = await c.s.insertInto('discovery_calling_policies').values({ name: 'Handover test policy' } as never).returning('id').executeTakeFirstOrThrow();
  const user = await c.s
    .insertInto('discovery_users')
    .values({ site_id: site.id, upn: 'jo@contoso.test', display_name: 'Jo Bloggs', calling_policy_id: policy.id } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  const [n] = await seedNumbers(c.s, 'LON01', ['+442070000201']);
  await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: user.id }).where('id', '=', n!.id).execute();

  const mem = new Map<string, Buffer>();
  const storage = {
    write: async (p: string, d: Buffer) => void mem.set(p, d),
    read: async (p: string) => mem.get(p)!,
    delete: async (p: string) => void mem.delete(p),
    exists: async (p: string) => mem.has(p),
  };
  files = new FilesService(handle.db, storage);
  svc = new HandoverService(handle.db, files, new HandoverDocumentService(), new AuditService(handle.db));
});

const docText = async (buf: Buffer) => (await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, ' ');
const hide = { hideDraftHandover: true };

describe('Service Handover', () => {
  let packId: string;
  let draftFileId: string;

  it('fills the users section from the right tables', async () => {
    const pack = await svc.generate(c.t, engineer, { notes: 'Internal: chase porting date' });
    packId = pack.id;
    draftFileId = pack.file_id!;
    const { sections } = await svc.get(c.t, engineer, packId);
    const users = sections.find((s) => s.key === 'teams_users')!.content as { columns: string[]; rows: string[][] };
    const row = Object.fromEntries(users.columns.map((col, i) => [col, users.rows[0]![i]]));
    expect(row).toMatchObject({ UPN: 'jo@contoso.test', Number: '+442070000201', 'Calling policy': 'Handover test policy' });
    const numbers = sections.find((s) => s.key === 'phone_numbers')!.content as { rows: string[][] };
    expect(numbers.rows[0]![2]).toBe('Jo Bloggs (User)');
  });

  it('keeps a draft away from customers, and marks its document DRAFT', async () => {
    expect(await svc.list(c.t, customer)).toEqual([]);
    await expect(svc.get(c.t, customer, packId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await files.list(c.t, { category: 'handover_pack' } as never, hide)).length).toBe(0);
    await expect(files.readBytes(c.t, draftFileId, hide)).rejects.toBeInstanceOf(NotFoundException);
    const { data } = await files.readBytes(c.t, draftFileId);
    expect(await docText(data)).toContain('DRAFT');
  });

  it('issues a document that says who issued it, and shows it to customers without the internal note', async () => {
    const issued = await svc.issue(c.t, engineer, packId);
    expect(issued.file_id).not.toBe(draftFileId);
    const text = await docText((await files.readBytes(c.t, issued.file_id!)).data);
    expect(text).toContain('Issued by');
    expect(text).toContain('Eve Engineer');
    expect(text).not.toContain('DRAFT');

    const seen = await svc.list(c.t, customer);
    expect(seen.map((p) => p.id)).toEqual([packId]);
    expect((seen[0]!.source as Record<string, unknown>).notes).toBeUndefined();
    expect(((await svc.get(c.t, engineer, packId)).pack.source as Record<string, unknown>).notes).toBe('Internal: chase porting date');
    const visible = await files.list(c.t, { category: 'handover_pack' } as never, hide);
    expect(visible.map((f) => f.id)).toEqual([issued.file_id]);
    // the superseded draft document stays hidden from customers
    await expect(files.readBytes(c.t, draftFileId, hide)).rejects.toBeInstanceOf(NotFoundException);
  });
});
