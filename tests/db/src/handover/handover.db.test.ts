// Service Handover documents what is deployed. A Design & Build row that
// matches live Teams goes in the pack with the live values; one that doesn't
// is listed under "Deployment Issues" with why, with the open validation issues. Drafts are for
// Voxshift staff only; customers see a pack once it's issued, without the
// internal note, and the issued document must not still say DRAFT.
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { VOX_TILE_PNG_BASE64 } from '../../../../apps/api/src/modules/deployment/assets/vox-tile';
import { readCompoundFile, readPackage } from '../../../../apps/api/src/modules/handover/embedded-pdf';
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

  it('embeds each live diagram as a PDF to double-click: the PDF the browser uploaded, or one made from the picture', async () => {
    const c4 = await seedCustomer(handle);
    const site4 = (await seedSite(c4.s, { sitecode: 'GLA01' })).id;
    const aa = (name: string) => ({ site_id: site4, name, resource_accounts: JSON.stringify([]), config: {}, holiday_call_flows: JSON.stringify([]) });
    await c4.s.insertInto('build_auto_attendants').values([aa('Main Number'), aa('Night Service')] as never).execute();
    await c4.s
      .insertInto('tenant_objects')
      .values([
        { object_type: 'auto_attendant', object_key: 'aa-1', display_name: 'Main Number', data: JSON.stringify({}) },
        { object_type: 'auto_attendant', object_key: 'aa-2', display_name: 'Night Service', data: JSON.stringify({}) },
      ] as never)
      .execute();

    const png = Buffer.from(VOX_TILE_PNG_BASE64, 'base64');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
    const up = async (originalname: string, buffer: Buffer) => (await svc.uploadDiagram(c4.t, engineer, { originalname, buffer })).fileId;
    const main = await up('call-flow-Main Number.png', png);
    const mainPdf = await up('call-flow-Main Number.pdf', pdf);
    const night = await up('call-flow-Night Service.png', png);
    // a PDF is stored as a PDF; anything that is neither a PNG nor a PDF is refused
    expect((await files.readBytes(c4.t, mainPdf)).data.equals(pdf)).toBe(true);
    await expect(svc.uploadDiagram(c4.t, engineer, { originalname: 'x.pdf', buffer: Buffer.from('%PD not really') })).rejects.toBeInstanceOf(BadRequestException);

    const pack = await svc.generate(c4.t, engineer, {
      diagrams: [
        { name: 'Main Number', fileId: main, pdfFileId: mainPdf, width: 1200, height: 500 },
        // a PDF that isn't one of this customer's diagrams is dropped: the pack makes one from the picture
        { name: 'Night Service', fileId: night, pdfFileId: '00000000-0000-4000-8000-000000000000', width: 600, height: 900 },
      ],
    });
    const { sections } = await svc.get(c4.t, engineer, pack.id);
    const images = (sections.find((x) => x.key === 'auto_attendants')!.content as { blocks: Block[] }).blocks.filter((b) => b.kind === 'image');
    expect(images).toEqual([
      { kind: 'image', fileId: main, pdfFileId: mainPdf, title: 'Main Number', width: 1200, height: 500, caption: 'Call Flow Diagram – Main Number' },
      { kind: 'image', fileId: night, title: 'Night Service', width: 600, height: 900, caption: 'Call Flow Diagram – Night Service' },
    ]);

    /** What a Word reader needs of the pack: the objects, their parts, and relationships and content types that hold together. */
    const check = async (fileId: string) => {
      const zip = await JSZip.loadAsync((await files.readBytes(c4.t, fileId)).data);
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml).not.toContain('__VXS_EMBED_');
      expect(xml).toMatch(/<w:document [^>]*xmlns:v="urn:schemas-microsoft-com:vml"/);
      expect(xml).toMatch(/<w:document [^>]*xmlns:o="urn:schemas-microsoft-com:office:office"/);
      const objects = [...xml.matchAll(/<w:object w:dxaOrig="1200" w:dyaOrig="1500"><v:shape id="([^"]+)" type="#_x0000_t75" style="width:60pt;height:75pt" o:ole=""><v:imagedata r:id="([^"]+)" o:title=""\/><\/v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="([^"]+)" DrawAspect="Icon" ObjectID="_\d+" r:id="([^"]+)"\/><\/w:object>/g)];
      expect(objects).toHaveLength(2);
      for (const [, shape, , shapeRef] of objects) expect(shapeRef).toBe(shape);
      // each object follows its figure caption, and names its PDF under the icon
      expect(xml.indexOf('Call Flow Diagram - Main Number.pdf')).toBeGreaterThan(xml.indexOf(objects[0]![0]));
      expect(xml.indexOf(objects[0]![0])).toBeGreaterThan(xml.indexOf('Call Flow Diagram – Main Number'));

      // every relationship the document uses exists, and every one's target is in the package
      const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
      const relTargets = new Map([...rels.matchAll(/<Relationship ([^>]*)\/>/g)].map(([, a]) => [/Id="([^"]+)"/.exec(a!)![1]!, { type: /Type="([^"]+)"/.exec(a!)![1]!, target: /Target="([^"]+)"/.exec(a!)![1]!, external: /TargetMode="External"/.test(a!) }]));
      expect(new Set(relTargets.keys()).size).toBe([...rels.matchAll(/<Relationship /g)].length); // ids unique
      for (const [, id] of xml.matchAll(/r:(?:id|embed)="([^"]+)"/g)) expect(relTargets.has(id!), id).toBe(true);
      for (const r of relTargets.values()) if (!r.external) expect(zip.file(`word/${r.target}`), r.target).not.toBeNull();
      const oles = objects.map(([, , icon, , ole]) => {
        expect(relTargets.get(icon!)).toEqual({ type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: 'media/vxs-pdf-icon.png', external: false });
        expect(relTargets.get(ole!)!.type).toBe('http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject');
        return relTargets.get(ole!)!.target;
      });
      expect(oles).toEqual(['embeddings/oleObject1.bin', 'embeddings/oleObject2.bin']);

      // every part has a content type: an override, or a default for its extension
      const types = await zip.file('[Content_Types].xml')!.async('string');
      const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(tag)?.[1];
      const defaults = new Map([...types.matchAll(/<Default [^>]*>/g)].map(([tag]) => [attr(tag, 'Extension')!.toLowerCase(), attr(tag, 'ContentType')]));
      const overrides = new Set([...types.matchAll(/<Override PartName="([^"]+)"/g)].map(([, p]) => p));
      expect(defaults.get('bin')).toBe('application/vnd.openxmlformats-officedocument.oleObject');
      expect(defaults.get('png')).toBe('image/png');
      for (const part of Object.keys(zip.files).filter((f) => !zip.files[f]!.dir && f !== '[Content_Types].xml')) {
        expect(overrides.has(`/${part}`) || defaults.has(part.split('.').pop()!.toLowerCase()), part).toBe(true);
      }

      // the objects carry the PDFs: the uploaded one as it was, and one made from the picture
      const carried = await Promise.all(oles.map(async (t) => readPackage(readCompoundFile(await zip.file(`word/${t}`)!.async('nodebuffer')).streams.get('\u0001Ole10Native')!)));
      expect(carried.map((p) => p.fileName)).toEqual(['Call Flow Diagram - Main Number.pdf', 'Call Flow Diagram - Night Service.pdf']);
      expect(carried[0]!.data.equals(pdf)).toBe(true);
      expect(carried[1]!.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(carried[1]!.data.length).toBeGreaterThan(png.length);
    };
    await check(pack.file_id!);
    // issuing draws the pack again from the stored diagrams: the objects are still there
    await check((await svc.issue(c4.t, engineer, pack.id, {})).file_id!);
  });
});

describe('Service Handover outstanding actions', () => {
  it('adds actions, ticks one off, and prints only the open ones in the pack (a site’s with its code)', async () => {
    const all = await svc.createAction(c.t, engineer, { siteId: null, description: 'Test 933 on the lobby phone', owner: 'AT&T' });
    const lon = await svc.createAction(c.t, engineer, { siteId, description: 'Fix the diagram' });
    const done = await svc.createAction(c.t, engineer, { siteId, description: 'Retire the old PBX', owner: 'Customer' });
    await svc.updateAction(c.t, engineer, done.id, { done: true });

    const listed = await svc.listActions(c.t);
    // open first, then done; who added and who ticked
    expect(listed.map((a) => [a.description, a.sitecode, !!a.done_at])).toEqual([
      ['Test 933 on the lobby phone', null, false],
      ['Fix the diagram', 'LON01', false],
      ['Retire the old PBX', 'LON01', true],
    ]);
    expect(listed[2]).toMatchObject({ created_by_name: 'Eve Engineer', done_by_name: 'Eve Engineer' });

    const pack = await svc.generate(c.t, engineer, {});
    const { sections } = await svc.get(c.t, engineer, pack.id);
    const actions = sections.find((s) => s.key === 'outstanding_actions')!.content as { kind: 'blocks'; blocks: Block[] };
    expect(actions.blocks[0]).toMatchObject({
      kind: 'actions',
      items: [
        { description: 'Test 933 on the lobby phone', owner: 'AT&T' },
        { description: 'LON01: Fix the diagram', owner: '' },
      ],
    });

    // opened again, edited, deleted
    await svc.updateAction(c.t, engineer, done.id, { done: false, description: 'Retire the old PBX by Friday' });
    expect((await svc.listActions(c.t, siteId)).find((a) => a.id === done.id)).toMatchObject({ done_at: null, done_by: null, description: 'Retire the old PBX by Friday' });
    await svc.deleteAction(c.t, engineer, lon.id);
    await svc.deleteAction(c.t, engineer, all.id);
    await expect(svc.deleteAction(c.t, engineer, all.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.listActions(c.t)).map((a) => a.description)).toEqual(['Retire the old PBX by Friday']);
  });

  it('ticking an action already done keeps who did it first, and an action can’t be added for an unknown site', async () => {
    const a = await svc.createAction(c.t, engineer, { siteId: null, description: 'Hand over the admin guide' });
    await svc.updateAction(c.t, engineer, a.id, { done: true });
    const first = (await svc.listActions(c.t)).find((x) => x.id === a.id)!;
    await svc.updateAction(c.t, customer, a.id, { done: true });
    expect((await svc.listActions(c.t)).find((x) => x.id === a.id)).toMatchObject({ done_by: first.done_by, done_at: first.done_at });
    await expect(svc.createAction(c.t, engineer, { siteId: '00000000-0000-4000-8000-000000000000', description: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

// Bug report "Service Handover - Pre creation check": before a draft is made, the engineer is told about port ranges on the pack's
// sites that have not been ported yet, and asked whether to go ahead.
describe('Service Handover with numbers still to port', () => {
  it('lists the port ranges not yet ported, refuses a draft until asked to go ahead, and asks nothing for sites that are done', async () => {
    const d = await seedCustomer(handle);
    await seedSite(d.s, { sitecode: 'MAN01' });
    const gla = (await seedSite(d.s, { sitecode: 'GLA01' })).id;
    await d.s
      .insertInto('discovery_number_ranges')
      .values([
        { range_start: '+441610000100', range_end: '+441610000199', kind: 'port', sitecode: 'MAN01', port_foc_date: '2026-11-20', port_submitted_to_carrier_at: '2026-11-01T09:00:00Z' },
        { range_start: '+441410000100', range_end: '+441410000109', kind: 'port', sitecode: 'GLA01', port_completed_at: '2026-11-05T12:00:00Z' },
        { range_start: '+441410000200', range_end: '+441410000209', kind: 'new', sitecode: 'GLA01' },
        // a port range on no site is not the pack's business
        { range_start: '+441000000000', range_end: '+441000000009', kind: 'port', sitecode: null },
      ] as never)
      .execute();

    const ranges = await svc.unportedRanges(d.t);
    expect(ranges).toEqual([{ sitecode: 'MAN01', siteName: 'MAN01', start: '+441610000100', end: '+441610000199', stage: expect.stringMatching(/20 Nov 2026/) }]);
    expect(await svc.unportedRanges(d.t, [gla])).toEqual([]);

    const refused = await svc.generate(d.t, engineer, {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    const body = (refused as ConflictException).getResponse() as { code: string; ranges: unknown[]; message: string };
    expect(body.code).toBe('confirm_unported');
    expect(body.ranges).toHaveLength(1);
    expect(body.message).toMatch(/not been ported yet/);
    expect(await d.s.selectFrom('handover_packs').select('id').execute()).toHaveLength(0);

    await svc.generate(d.t, engineer, { acceptUnported: true });
    await svc.generate(d.t, engineer, { siteIds: [gla] });
    expect(await d.s.selectFrom('handover_packs').select('id').execute()).toHaveLength(2);
  });
});
