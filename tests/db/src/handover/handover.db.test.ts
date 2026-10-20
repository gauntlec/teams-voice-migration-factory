// Service Handover documents what is deployed. A Design & Build row that
// matches live Teams goes in the pack with the live values; one that doesn't
// is listed under "Designed but Not Yet Live" with why. Drafts are for
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
let siteId: string;

const buildUser = (upn: string, extra: Record<string, unknown>) =>
  c.s
    .insertInto('build_users')
    .values({ site_id: siteId, upn, policies: {}, policy_ids: {}, voicemail: {}, call_forwarding: {}, delegates: '[]', pickup_group: {}, validation: {}, status: {}, ...extra } as never)
    .returning('id')
    .executeTakeFirstOrThrow()
    .then((r) => r.id);

/** A user as Discovery last saw them in Teams. */
async function liveUser(upn: string, displayName: string, lineUri: string | null, policies: Record<string, string>) {
  const obj = await c.s
    .insertInto('tenant_objects')
    .values({ object_type: 'user', object_key: upn, display_name: displayName, data: {} } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  await c.s
    .insertInto('tenant_users')
    .values({ object_id: obj.id, upn, display_name: displayName, account_type: 'User', enterprise_voice_enabled: true, line_uri: lineUri, policies } as never)
    .execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Eve Engineer' });
  customer = await seedUser(handle, 'CUSTOMER', { displayName: 'Cara Customer' });
  siteId = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  await seedNumbers(c.s, 'LON01', ['+442070000201', '+442070000202', '+442070000203']);

  // Jo: designed and live, matching. Sam: designed with a number Teams doesn't have yet. Pat: not in Teams at all.
  const jo = await buildUser('jo@contoso.test', { e164: '+442070000201', number_type: 'DirectRouting', policies: { voice_routing_policy: 'VRP-UK' } });
  await buildUser('sam@contoso.test', { e164: '+442070000202', number_type: 'DirectRouting' });
  await buildUser('pat@contoso.test', { e164: '+442070000203', number_type: 'DirectRouting' });
  await liveUser('jo@contoso.test', 'Jo Bloggs', 'tel:+442070000201', { OnlineVoiceRoutingPolicy: 'VRP-UK' });
  await liveUser('sam@contoso.test', 'Sam Smith', null, {});
  await c.s
    .insertInto('build_call_queues')
    .values({ site_id: siteId, name: 'Sales', agents: '["jo@contoso.test"]', resource_accounts: '[]', overflow: {}, timeout: {}, routing_method: 'Attendant' } as never)
    .execute();

  // Voxshift changed Jo live, and Discovery last read Teams after that.
  const dep = await c.s
    .insertInto('deployments')
    .values({ mode: 'execute', status: 'completed', scope: { siteId }, created_by: engineer.id, summary: {} } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  await c.s
    .insertInto('deployment_changes')
    .values({ deployment_id: dep.id, seq: 1, correlation_id: 'x', object_type: 'user', object_id: jo, cmdlet: 'Set-CsPhoneNumberAssignment', result: 'applied', at: '2026-10-01T10:00:00Z' } as never)
    .execute();
  await c.s
    .insertInto('tenant_discovery_runs')
    .values({ status: 'completed', started_by: engineer.id, finished_at: '2026-10-02T09:00:00Z' } as never)
    .execute();

  const mem = new Map<string, Buffer>();
  const storage = {
    write: async (p: string, d: Buffer) => void mem.set(p, d),
    read: async (p: string) => mem.get(p)!,
    delete: async (p: string) => void mem.delete(p),
    exists: async (p: string) => mem.has(p),
    deleteFolder: async () => {},
    folderStats: async () => ({ files: 0, bytes: 0 }),
  };
  files = new FilesService(handle.db, storage);
  svc = new HandoverService(handle.db, files, new HandoverDocumentService(), new AuditService(handle.db));
});

const docText = async (buf: Buffer) => (await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, ' ');
const hide = { hideDraftHandover: true };
type Table = { columns: string[]; rows: string[][] };
const asRecords = (t: Table) => t.rows.map((r) => Object.fromEntries(t.columns.map((col, i) => [col, r[i]])));

describe('Service Handover', () => {
  let packId: string;
  let draftFileId: string;

  it('lists only what is live, with the live values, and the rest as not yet live', async () => {
    const pack = await svc.generate(c.t, engineer, { notes: 'Internal: chase porting date' });
    packId = pack.id;
    draftFileId = pack.file_id!;
    const { sections } = await svc.get(c.t, engineer, packId);
    const section = (key: string) => sections.find((s) => s.key === key)!.content as Table;

    expect(asRecords(section('teams_users'))).toEqual([
      expect.objectContaining({
        UPN: 'jo@contoso.test',
        'Display name': 'Jo Bloggs',
        Number: '+442070000201',
        'Voice routing policy': 'VRP-UK',
        'Calling policy': 'Global',
        'Last changed by Voxshift': '1 Oct 2026',
      }),
    ]);

    const notLive = asRecords(section('not_yet_live'));
    expect(notLive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Item: 'sam@contoso.test', Type: 'User', 'What differs from the design': expect.stringContaining('+442070000202') }),
        expect.objectContaining({ Item: 'pat@contoso.test', Type: 'User', 'What differs from the design': 'Not found in Teams' }),
        expect.objectContaining({ Item: 'Sales', Type: 'Call queue', 'What differs from the design': 'Not found in Teams' }),
      ]),
    );
    expect(section('call_queues').rows).toEqual([]);

    const numbers = asRecords(section('phone_numbers'));
    expect(numbers.find((n) => n.Number === '+442070000201')).toMatchObject({ Status: 'In use', 'Assigned to (in Teams)': 'Jo Bloggs (User)' });
    expect(numbers.find((n) => n.Number === '+442070000202')).toMatchObject({ Status: 'Spare' });
  });

  it('keeps a draft away from customers, and marks its document DRAFT', async () => {
    expect(await svc.list(c.t, customer)).toEqual([]);
    await expect(svc.get(c.t, customer, packId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await files.list(c.t, { category: 'handover_pack' } as never, hide)).length).toBe(0);
    await expect(files.readBytes(c.t, draftFileId, hide)).rejects.toBeInstanceOf(NotFoundException);
    const text = await docText((await files.readBytes(c.t, draftFileId)).data);
    expect(text).toContain('DRAFT');
    expect(text).toContain('Checked against Teams');
    expect(text).toContain('2 October 2026');
  });

  it('issues a document that says who issued it, and shows it to customers without the internal note', async () => {
    const issued = await svc.issue(c.t, engineer, packId);
    expect(issued.file_id).not.toBe(draftFileId);
    const text = await docText((await files.readBytes(c.t, issued.file_id!)).data);
    expect(text).toContain('Issued by');
    expect(text).toContain('Eve Engineer');
    expect(text).not.toContain('DRAFT');
    expect(text).toContain('2 October 2026'); // same live snapshot date as the draft

    const seen = await svc.list(c.t, customer);
    expect(seen.map((p) => p.id)).toEqual([packId]);
    expect((seen[0]!.source as Record<string, unknown>).notes).toBeUndefined();
    expect(((await svc.get(c.t, engineer, packId)).pack.source as Record<string, unknown>).notes).toBe('Internal: chase porting date');
    const visible = await files.list(c.t, { category: 'handover_pack' } as never, hide);
    expect(visible.map((f) => f.id)).toEqual([issued.file_id]);
    await expect(files.readBytes(c.t, draftFileId, hide)).rejects.toBeInstanceOf(NotFoundException);
  });
});
