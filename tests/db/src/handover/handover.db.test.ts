// Service Handover documents what is deployed. A Design & Build row that
// matches live Teams goes in the pack with the live values; one that doesn't
// is listed under "Deployment Issues" with why, with the open validation issues. Drafts are for
// Voxshift staff only; customers see a pack once it's issued, without the
// internal note, and the issued document must not still say DRAFT.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { VOX_TILE_PNG_BASE64 } from '../../../../apps/api/src/modules/deployment/assets/vox-tile';
import { HandoverDocumentService } from '../../../../apps/api/src/modules/handover/handover-document.service';
import { HandoverService } from '../../../../apps/api/src/modules/handover/handover.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

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
  const audit = new AuditService(handle.db);
  const build = new BuildService(handle.db, audit, new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
  svc = new HandoverService(handle.db, files, new HandoverDocumentService(), audit, undefined, build);
});

const docText = async (buf: Buffer) => (await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string')).replace(/<[^>]+>/g, ' ');
const hide = { hideDraftHandover: true };
type Table = { columns: string[]; rows: string[][] };
type Block = import('@tvmf/shared').HandoverBlock;
const asRecords = (t: Table) => t.rows.map((r) => Object.fromEntries(t.columns.map((col, i) => [col, r[i]])));

describe('Service Handover', () => {
  let packId: string;
  let draftFileId: string;

  it('lists only what is live, with the live values, and the rest as not yet live', async () => {
    const pack = await svc.generate(c.t, engineer, { notes: 'Internal: chase porting date' });
    packId = pack.id;
    draftFileId = pack.file_id!;
    const { sections } = await svc.get(c.t, engineer, packId);
    const blocksOf = (key: string) => (sections.find((s) => s.key === key)!.content as { kind: 'blocks'; blocks: Block[] }).blocks;
    // a section's tables (laid out as the template: lead-in sentences, sub-headings and tables)
    const tables = (key: string) => blocksOf(key).filter((b): b is Extract<Block, { kind: 'table' }> => b.kind === 'table');
    const section = (key: string) => tables(key)[0]!;

    expect(asRecords(section('teams_users'))).toEqual([
      { 'User Principal Name (UPN)': 'jo@contoso.test', 'DID Number': '+442070000201', 'Physical Phone': 'No', 'Voice Routing Policy': 'VRP-UK' },
    ]);
    expect(blocksOf('teams_users')[0]).toEqual({ kind: 'text', text: 'The following users were enabled:' });

    const notLive = asRecords(section('not_yet_live'));
    expect(notLive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Item: 'sam@contoso.test', Type: 'User', 'What differs from the design': expect.stringContaining('+442070000202') }),
        expect.objectContaining({ Item: 'pat@contoso.test', Type: 'User', 'What differs from the design': 'Not found in Teams' }),
        expect.objectContaining({ Item: 'Sales', Type: 'Call queue', 'What differs from the design': 'Not found in Teams' }),
      ]),
    );
    expect(blocksOf('call_queues')).toEqual([{ kind: 'text', text: 'No call queues were created.' }]);
    // Deployment Issues: what isn't live, then the open validation issues (Pat isn't in the tenant)
    expect(blocksOf('not_yet_live').filter((b) => b.kind === 'heading').map((b) => (b as { title: string }).title)).toEqual(['Designed but Not Yet Live', 'Validation Issues']);
    const issues = asRecords(tables('not_yet_live').find((t) => (t as { caption?: string }).caption === 'Validation Issues Table')!);
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ Item: 'pat@contoso.test', Type: 'User', Site: 'LON01', Issue: 'Not in tenant (blocks deployment)' })]));

    const numberTables = tables('phone_numbers');
    const numbers = numberTables.filter((t) => t.columns[0] === 'Number').flatMap(asRecords);
    expect(numbers.find((n) => n.Number === '+442070000201')).toMatchObject({ Status: 'In use', 'Assigned to (in Teams)': 'Jo Bloggs (User)' });
    expect(numbers.find((n) => n.Number === '+442070000202')).toMatchObject({ Status: 'Spare' });
    // the section opens with the site's ranges, then the allocation summary: always the same four rows
    expect(numberTables[0]).toMatchObject({ caption: 'Number Ranges Table', rows: [['+442070000201 – +442070000203', 'New', '—', 'LON01', '3']] });
    expect(blocksOf('phone_numbers')[1]).toEqual({ kind: 'text', text: 'A total of 3 x numbers in 1 x range were provided for this site:' });
    expect(numberTables[1]!.caption).toBe('Number Allocations Table');
    expect(asRecords(numberTables[1]!).map((r) => [r.Allocation, r.Quantity])).toEqual([
      ['Assigned to an object', '1'],
      ['Spare', '2'],
      ['Parked', '0'],
      ['Customer to cease', '0'],
    ]);
    expect(asRecords(numberTables[1]!)[2]!.Comments).toMatch(/^The carrier retains control of the number/);

    // the policies the live users have, from data rather than a note
    expect(tables('teams_configuration').find((t) => t.columns[0] === 'Voice Routing Policy')!.rows).toEqual([['VRP-UK']]);
    // the site as a label table
    expect(blocksOf('site_information')[0]).toMatchObject({ kind: 'labels', rows: expect.arrayContaining([['Site Code', 'LON01']]) });
    // the standard introduction until one is written
    expect(blocksOf('introduction')[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('formal hand-over pack') });
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

  it('prints the project line it was given, keeps it for the next pack, and sets the paper by the sites’ country', async () => {
    await c.s.updateTable('discovery_sites').set({ country: 'United States', name: 'London HQ' } as never).execute();
    const first = await svc.generate(c.t, engineer, { projectName: 'AT&T Global Teams Project', siteIds: [siteId] });
    const src = (id: string) => c.s.selectFrom('handover_packs').select('source').where('id', '=', id).executeTakeFirstOrThrow().then((r) => r.source as Record<string, unknown>);
    expect(await src(first.id)).toMatchObject({ projectName: 'AT&T Global Teams Project', siteLabel: 'London HQ', pageSize: 'letter' });
    const doc = await docText((await files.readBytes(c.t, first.file_id!)).data);
    expect(doc).toContain('AT&amp;T Global Teams Project');
    // the next pack keeps the project line unless it is changed; an empty one clears it
    const second = await svc.generate(c.t, engineer, {});
    expect(await src(second.id)).toMatchObject({ projectName: 'AT&T Global Teams Project' });
    const third = await svc.generate(c.t, engineer, { projectName: '' });
    expect(await src(third.id)).toMatchObject({ projectName: null });
    await c.s.updateTable('discovery_sites').set({ country: 'GB' } as never).execute();
    expect(await src((await svc.generate(c.t, engineer, {})).id)).toMatchObject({ pageSize: 'a4' });
  });

  it('numbers versions major.minor, prints sign-off and the version history', async () => {
    const c2 = await seedCustomer(handle);
    await seedSite(c2.s, { sitecode: 'HAU01' });
    const svc2 = svc;
    const a = await svc2.generate(c2.t, engineer, { changeNote: 'Draft issued for comment' });
    const b = await svc2.generate(c2.t, engineer, { changeNote: 'Section 7 added for call queues' });
    const label = (id: string) => c2.s.selectFrom('handover_packs').select(['version_label', 'source']).where('id', '=', id).executeTakeFirstOrThrow();
    expect((await label(a.id)).version_label).toBe('0.1');
    expect((await label(b.id)).version_label).toBe('0.2');

    const issued = await svc2.issue(c2.t, engineer, b.id, { approverCompany: 'AT&T', approverName: 'Leigh Manton, AT&T Consulting, Director EMEA', approvalDate: '2026-10-30' });
    expect(issued.version_label).toBe('1.0');
    expect(((await label(b.id)).source as Record<string, unknown>).approval).toEqual({ company: 'AT&T', name: 'Leigh Manton, AT&T Consulting, Director EMEA', date: '2026-10-30' });
    const doc = await docText((await files.readBytes(c2.t, issued.file_id!)).data);
    for (const t of ['Approved and signed off by:', 'AT&amp;T', 'Leigh Manton, AT&amp;T Consulting, Director EMEA', '30 October 2026', 'Document Control', '0.1 (draft)', 'Draft issued for comment', 'Section 7 added for call queues', 'Version 1.0']) expect(doc).toContain(t);

    // after the first issue, the next pack is 1.1
    const c = await svc2.generate(c2.t, engineer, {});
    expect((await label(c.id)).version_label).toBe('1.1');
  });

  it('counts versions for each site on its own, never reusing a number, and names the site in the file', async () => {
    const c4 = await seedCustomer(handle);
    const rdg = (await seedSite(c4.s, { sitecode: 'RDG01' })).id;
    const lds = (await seedSite(c4.s, { sitecode: 'LDS01' })).id;
    const gen = (siteIds?: string[], changeNote?: string) => svc.generate(c4.t, engineer, { ...(siteIds ? { siteIds } : {}), ...(changeNote ? { changeNote } : {}) });
    const label = (p: { id: string }) => c4.s.selectFrom('handover_packs').select('version_label').where('id', '=', p.id).executeTakeFirstOrThrow().then((r) => r.version_label);

    const rdg1 = await gen([rdg]);
    const lds1 = await gen([lds]);
    const rdg2 = await gen([rdg], 'A change at Reading');
    const all1 = await gen();
    expect([await label(rdg1), await label(lds1), await label(rdg2), await label(all1)]).toEqual(['0.1', '0.1', '0.2', '0.1']);
    // the screen's list shows the version as printed
    expect((await svc.list(c4.t, engineer)).map((p) => p.version_label)).toEqual(['0.1', '0.2', '0.1', '0.1']);

    // the two 0.1s are different files, and each site's Document Control lists only its own packs
    const name = (p: { file_id: string | null }) => c4.s.selectFrom('files').select('filename').where('id', '=', p.file_id!).executeTakeFirstOrThrow().then((r) => r.filename);
    expect(await name(rdg1)).toContain('RDG01-v0.1');
    expect(await name(lds1)).toContain('LDS01-v0.1');
    const leeds2 = await gen([lds]);
    expect(await docText((await files.readBytes(c4.t, leeds2.file_id!)).data)).not.toContain('A change at Reading');
    expect(await label(leeds2)).toBe('0.2');

    // issuing at one site leaves the other in drafts
    expect((await svc.issue(c4.t, engineer, rdg2.id, {})).version_label).toBe('1.0');
    expect(await label(await gen([lds]))).toBe('0.3');
    expect(await label(await gen([rdg]))).toBe('1.1');
    // an older draft issued afterwards doesn't print a second 1.0
    expect((await svc.issue(c4.t, engineer, rdg1.id, {})).version_label).toBe('1.2');
    // a site that carries numbers from before each site counted on its own goes on from its highest
    await c4.s.updateTable('handover_packs').set({ version_label: '0.9' }).where('id', '=', lds1.id).execute();
    expect(await label(await gen([lds]))).toBe('0.10');
  });

  it('builds the diagrams from what is live in Teams: only the site\'s attendants, with people by name', async () => {
    const c5 = await seedCustomer(handle);
    const here = (await seedSite(c5.s, { sitecode: 'HERE1' })).id;
    const there = (await seedSite(c5.s, { sitecode: 'THERE' })).id;
    const design = (site_id: string, name: string) => ({ site_id, name, resource_accounts: JSON.stringify([]), config: {}, holiday_call_flows: JSON.stringify([]) });
    await c5.s.insertInto('build_auto_attendants').values([design(here, 'Main Number'), design(here, 'Main Overflow'), design(here, 'Designed Only'), design(there, 'Elsewhere')] as never).execute();
    const flow = (id: string) => ({ DefaultCallFlow: { Id: 'cf', Greetings: [], Menu: { MenuOptions: [{ DtmfResponse: 100, Action: 'TransferCallToTarget', CallTarget: { Id: id, Type: 'ApplicationEndpoint' } }] } } });
    const AGENT = 'aaaaaaaa-0000-4000-8000-000000000001';
    const LEFT = 'aaaaaaaa-0000-4000-8000-000000000002';
    const UNKNOWN = 'bbbbbbbb-0000-4000-8000-000000000003';
    await c5.s
      .insertInto('tenant_objects')
      .values(
        [
          { object_type: 'auto_attendant', object_key: 'aa-over', display_name: 'Main Overflow', data: JSON.stringify({ Identity: 'aa-over', ...flow('ra-q'), ApplicationInstances: ['ra-over'] }) },
          { object_type: 'auto_attendant', object_key: 'aa-main', display_name: 'Main Number', data: JSON.stringify({ Identity: 'aa-main', ...flow('ra-over'), ApplicationInstances: ['ra-main'] }) },
          { object_type: 'auto_attendant', object_key: 'aa-else', display_name: 'Elsewhere', data: JSON.stringify({ Identity: 'aa-else', ...flow('ra-q') }) },
          { object_type: 'call_queue', object_key: 'q', display_name: 'Reception', data: JSON.stringify({ Identity: 'q', ApplicationInstances: ['ra-q'], Agents: [{ ObjectId: AGENT.toUpperCase() }, { ObjectId: LEFT }, { ObjectId: UNKNOWN }] }) },
          { object_type: 'resource_account', object_key: 'ra-main', display_name: 'Main RA', data: JSON.stringify({ UserPrincipalName: 'main@contoso.test', PhoneNumber: 'tel:+15550001' }) },
          { object_type: 'resource_account', object_key: 'ra-over', display_name: 'Overflow RA', data: JSON.stringify({ UserPrincipalName: 'over@contoso.test' }) },
        ] as never,
      )
      .execute();
    const person = async (entra_id: string, upn: string, removed_at?: string) => {
      const obj = await c5.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
      await c5.s.insertInto('tenant_users').values({ object_id: obj.id, entra_id, upn, display_name: upn, account_type: 'User', ...(removed_at ? { removed_at } : {}) } as never).execute();
    };
    await person(AGENT, 'agent@contoso.test');
    await person(LEFT, 'left@contoso.test', '2026-10-01T00:00:00.000Z');

    const graphs = await svc.callFlowGraphs(c5.t, [here]);
    // the Main Number has the phone number, and its diagram already shows the Overflow, so there's one diagram; nothing from the other site or only designed
    expect(graphs.map((g) => g.name)).toEqual(['Main Number']);
    const nodes = graphs[0]!.graph.nodes;
    expect(nodes.some((n) => n.label === 'Main Overflow')).toBe(true);
    expect(nodes.some((n) => n.label === 'Elsewhere' || n.label === 'Designed Only')).toBe(false);
    // the people show by name, someone since removed from the sync too; only someone Voxshift has never seen is a shortened id
    expect(nodes.find((n) => n.label === 'Reception')!.agents).toEqual(['agent@contoso.test', 'left@contoso.test', 'User (bbbbbbbb…)']);
    // and the whole customer has the other site's attendant too
    expect((await svc.callFlowGraphs(c5.t)).map((g) => g.name)).toContain('Elsewhere');
  });

  it('keeps the call flow diagrams the browser drew with the pack, and prints them for live auto attendants', async () => {
    const c3 = await seedCustomer(handle);
    const site3 = (await seedSite(c3.s, { sitecode: 'HAU02' })).id;
    await c3.s.insertInto('build_auto_attendants').values([{ site_id: site3, name: 'Main Number', resource_accounts: JSON.stringify([]), config: {}, holiday_call_flows: JSON.stringify([]) }, { site_id: site3, name: 'Not Live', resource_accounts: JSON.stringify([]), config: {}, holiday_call_flows: JSON.stringify([]) }] as never).execute();
    await c3.s.insertInto('tenant_objects').values({ object_type: 'auto_attendant', object_key: 'aa-1', display_name: 'Main Number', data: JSON.stringify({}) } as never).execute();

    // only a PNG is taken
    await expect(svc.uploadDiagram(c3.t, engineer, { originalname: 'x.png', buffer: Buffer.from('not a picture') })).rejects.toBeInstanceOf(BadRequestException);
    const png = Buffer.from(VOX_TILE_PNG_BASE64, 'base64');
    const up = async (name: string) => (await svc.uploadDiagram(c3.t, engineer, { originalname: `call-flow-${name}.png`, buffer: png })).fileId;
    const main = await up('Main Number');
    const notLive = await up('Not Live');

    const pack = await svc.generate(c3.t, engineer, {
      diagrams: [
        { name: 'Main Number', fileId: main, width: 1200, height: 500 },
        { name: 'Not Live', fileId: notLive, width: 1200, height: 500 },
        // not one of this customer's diagrams: ignored
        { name: 'Main Number', fileId: '00000000-0000-4000-8000-000000000000', width: 10, height: 10 },
      ],
    });
    const { sections } = await svc.get(c3.t, engineer, pack.id);
    const blocks = (sections.find((x) => x.key === 'auto_attendants')!.content as { blocks: Block[] }).blocks;
    expect(blocks.filter((b) => b.kind === 'heading')).toEqual([{ kind: 'heading', title: 'Call Flow Diagram' }]);
    expect(blocks.filter((b) => b.kind === 'image')).toEqual([{ kind: 'image', fileId: main, title: 'Main Number', width: 1200, height: 500, caption: 'Call Flow Diagram – Main Number' }]);

    const media = async (fileId: string) => Object.keys((await JSZip.loadAsync((await files.readBytes(c3.t, fileId)).data)).files).filter((f) => f.startsWith('word/media/')).length;
    const draftMedia = await media(pack.file_id!);
    // issuing draws it again from the same stored picture
    const issued = await svc.issue(c3.t, engineer, pack.id, {});
    expect(await media(issued.file_id!)).toBe(draftMedia);
    expect(await docText((await files.readBytes(c3.t, issued.file_id!)).data)).toContain('Main Number');

    // they belong to the pack: not in the Files list, and not readable by a customer
    expect((await files.list(c3.t, {} as never)).some((f) => f.category === 'handover_diagram')).toBe(false);
    await expect(files.readBytes(c3.t, main, hide)).rejects.toBeInstanceOf(NotFoundException);
  });
});
