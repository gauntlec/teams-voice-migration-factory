import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { planIdentityRows, planResourceAccountRows, platformDb, tenantDb, type PlannedIdentityRow } from '@tvmf/db';
import {
  can,
  contactLabel,
  HANDOVER_NOTE_SECTIONS,
  HANDOVER_SECTIONS,
  handoverScopeLabel,
  lineUriToNumber,
  verificationRowDifferences,
  type LiveIdentityState,
  noteSectionContent,
  selectSections,
  type DiscoverySiteOverview,
  type HandoverNote,
  type HandoverNoteSection,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertCustomerWide } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';
import { HandoverDocumentService, type HandoverSectionContent, type HandoverSectionData } from './handover-document.service';

/** What a pack covers: the sites chosen (empty = every site) and the section keys chosen (empty = every section). */
export interface HandoverGenerateInput {
  notes?: string;
  siteIds?: string[];
  sectionKeys?: string[];
}

export interface HandoverNoteInput {
  sectionKey: HandoverNoteSection;
  siteId?: string | null;
  body: string;
}

/** The resolved site filter used by every section query. */
interface SiteScope {
  ids: string[];
  codes: string[];
}

function targetSummary(settings: { action?: string; threshold?: number; target?: string | null } | null): string {
  if (!settings?.action) return '—';
  const parts = [settings.action];
  if (settings.target) parts.push(`→ ${settings.target}`);
  if (settings.threshold != null) parts.push(`(${settings.threshold}s)`);
  return parts.join(' ');
}

/** Staff who build packs see drafts and internal notes; everyone else only issued packs. */
function isPackAuthor(user: AuthedUser): boolean {
  return can(user.role, 'handover:generate');
}

/** The Generate dialog's internal note is for Voxshift only - not sent to customers. */
function withoutInternalNote<T extends { source: unknown }>(pack: T): T {
  const source = (pack.source ?? {}) as Record<string, unknown>;
  const { notes: _internal, ...rest } = source;
  return { ...pack, source: rest };
}

function jsonArrayLength(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

@Injectable()
export class HandoverService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly files: FilesService,
    private readonly documentBuilder: HandoverDocumentService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A pack covers the whole customer (every site's users, numbers and network
   * data), so a site contact - a customer user pinned to certain sites - can't
   * read, build or issue one. The files endpoint already refuses them the .docx.
   */
  async list(t: TenantContext, user: AuthedUser) {
    assertCustomerWide(t, 'The Service Handover pack');
    const staff = isPackAuthor(user);
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom('handover_packs')
      .select(['id', 'version', 'status', 'generated_by', 'generated_at', 'file_id', 'issued_by', 'issued_at', 'source', 'created_at'])
      // A draft is still being prepared - customers only ever see issued packs.
      .$if(!staff, (qb) => qb.where('status', '=', 'issued'))
      .orderBy('version', 'desc')
      .execute();
    return staff ? rows : rows.map(withoutInternalNote);
  }

  async get(t: TenantContext, user: AuthedUser, id: string) {
    assertCustomerWide(t, 'The Service Handover pack');
    const scoped = tenantDb(this.db, t.schema);
    const [pack, sections] = await Promise.all([
      scoped.selectFrom('handover_packs').selectAll().where('id', '=', id).executeTakeFirst(),
      scoped.selectFrom('handover_sections').selectAll().where('pack_id', '=', id).orderBy('ordinal').execute(),
    ]);
    const staff = isPackAuthor(user);
    if (!pack || (!staff && pack.status !== 'issued')) throw new NotFoundException('handover pack not found');
    return { pack: staff ? pack : withoutInternalNote(pack), sections };
  }

  /** The sites a pack is limited to, checked against this tenant. No ids = every site (null). */
  private async resolveScope(t: TenantContext, siteIds?: string[]): Promise<SiteScope | null> {
    const wanted = [...new Set(siteIds ?? [])];
    if (wanted.length === 0) return null;
    const rows = await tenantDb(this.db, t.schema).selectFrom('discovery_sites').select(['id', 'sitecode']).where('id', 'in', wanted).execute();
    if (rows.length !== wanted.length) throw new BadRequestException('One or more of the chosen sites does not exist in this customer.');
    return { ids: rows.map((r) => r.id), codes: rows.map((r) => r.sitecode) };
  }

  async generate(t: TenantContext, user: AuthedUser, body: HandoverGenerateInput) {
    assertCustomerWide(t, 'The Service Handover pack');
    const scoped = tenantDb(this.db, t.schema);
    const scope = await this.resolveScope(t, body.siteIds);
    // Sections are read before the transaction so the lock is held only for the writes.
    const built = await this.buildSections(t, scope);
    const sections = selectSections(built.sections, body.sectionKeys);
    if (sections.length === 0) throw new BadRequestException('Choose at least one section for the pack.');
    const generatedAt = new Date();
    const packId = randomUUID();
    const scopeLabel = handoverScopeLabel(scope?.codes);

    // The version read and the pack + section inserts share one transaction under
    // an advisory lock, so two concurrent Generate requests can't both take the
    // same max(version) + 1, and a failed insert can't leave a half-written pack.
    const { pack, version, data } = await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${t.schema} || ':handover_pack'))`.execute(trx);
      const s = tenantDb(trx, t.schema);
      const last = await s.selectFrom('handover_packs').select((eb) => eb.fn.max('version').as('v')).executeTakeFirst();
      const version = Number(last?.v ?? 0) + 1;

      const data = await this.documentBuilder.build({
        tenantName: t.name,
        version,
        generatedBy: user.displayName,
        generatedAt,
        scope: scopeLabel,
        sections,
        liveAsOf: built.liveAsOf ? new Date(built.liveAsOf) : null,
        status: { kind: 'draft' },
      });

      const pack = await s
        .insertInto('handover_packs')
        .values({
          id: packId,
          version,
          status: 'draft',
          generated_by: user.id,
          generated_at: generatedAt.toISOString(),
          source: {
            notes: body.notes ?? null,
            snapshotAt: generatedAt.toISOString(),
            siteIds: scope?.ids ?? [],
            siteCodes: scope?.codes ?? [],
            sectionKeys: sections.map((x) => x.key),
            // when Discovery last read Teams - the "live" every as-built table is checked against
            liveAsOf: built.liveAsOf,
          },
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await s
        .insertInto('handover_sections')
        .values(sections.map((sec, i) => ({ pack_id: pack.id, key: sec.key, title: sec.title, ordinal: i, content: sec.content })))
        .execute();

      return { pack, version, data };
    });

    let file;
    try {
      file = await this.files.store(t, {
        category: 'handover_pack',
        sourceType: 'handover_pack',
        sourceId: pack.id,
        siteId: null,
        filename: `${t.schema}-service-handover-v${version}.docx`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data,
        uploadedBy: user.id,
        metadata: { version },
      });
    } catch (err) {
      // Don't leave a draft pack behind with no file to download (sections cascade).
      await scoped.deleteFrom('handover_packs').where('id', '=', pack.id).execute();
      throw err;
    }

    const updated = await scoped
      .updateTable('handover_packs')
      .set({ file_id: file.id })
      .where('id', '=', pack.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.tenant(t.schema, 'handover.pack_generated', {
      actor: { id: user.id, email: user.email },
      targetType: 'handover_pack',
      targetId: pack.id,
      detail: { version, fileId: file.id, scope: scopeLabel, sections: sections.length },
    });

    return { ...updated, sections: sections.length };
  }

  /**
   * Locks a draft pack as final. The pack's .docx was generated when the draft was
   * created, so this records who issued it and when rather than regenerating.
   */
  async issue(t: TenantContext, user: AuthedUser, id: string) {
    assertCustomerWide(t, 'The Service Handover pack');
    const scoped = tenantDb(this.db, t.schema);
    const pack = await scoped.selectFrom('handover_packs').select(['id', 'version', 'status', 'file_id']).where('id', '=', id).executeTakeFirst();
    if (!pack) throw new NotFoundException('handover pack not found');
    if (pack.status === 'issued') throw new ConflictException('This pack has already been issued.');
    if (!pack.file_id) throw new BadRequestException('This pack has no document, so it cannot be issued. Generate it again.');

    // The draft's document says DRAFT, so issuing re-renders it from the pack's
    // saved sections (the same snapshot - nothing is re-read from live data)
    // with who issued it and when. Before, the issued pack kept the draft's
    // file, so a draft sent out early looked exactly like the final one.
    const full = await scoped.selectFrom('handover_packs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const savedSections = await scoped.selectFrom('handover_sections').selectAll().where('pack_id', '=', id).orderBy('ordinal').execute();
    const author = await platformDb(this.db).selectFrom('users').select('display_name').where('id', '=', full.generated_by).executeTakeFirst();
    const issuedAt = new Date();
    const source = (full.source ?? {}) as { siteCodes?: string[]; liveAsOf?: string | null };
    const data = await this.documentBuilder.build({
      tenantName: t.name,
      version: full.version,
      generatedBy: author?.display_name ?? 'Voxshift',
      generatedAt: new Date(full.generated_at ?? full.created_at),
      scope: handoverScopeLabel(source.siteCodes),
      sections: savedSections.map((sec) => ({ key: sec.key, title: sec.title, content: sec.content as HandoverSectionContent })),
      liveAsOf: source.liveAsOf ? new Date(source.liveAsOf) : null,
      status: { kind: 'issued', issuedBy: user.displayName, issuedAt },
    });
    const file = await this.files.store(t, {
      category: 'handover_pack',
      sourceType: 'handover_pack',
      sourceId: id,
      siteId: null,
      filename: `${t.schema}-service-handover-v${full.version}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data,
      uploadedBy: user.id,
      metadata: { version: full.version, issued: true },
    });

    // Guarded on status so two people issuing at once cannot both succeed.
    const updated = await scoped
      .updateTable('handover_packs')
      .set({ status: 'issued', issued_by: user.id, issued_at: issuedAt.toISOString(), file_id: file.id })
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This pack was just issued by someone else.');

    await this.audit.tenant(t.schema, 'handover.pack_issued', {
      actor: { id: user.id, email: user.email },
      targetType: 'handover_pack',
      targetId: id,
      detail: { version: pack.version },
    });
    return updated;
  }

  /* ------------------------------- notes ------------------------------- */

  listNotes(t: TenantContext) {
    assertCustomerWide(t, 'The Service Handover pack');
    return tenantDb(this.db, t.schema)
      .selectFrom('handover_notes as n')
      .leftJoin('discovery_sites as ds', 'ds.id', 'n.site_id')
      .select(['n.id as id', 'n.section_key as section_key', 'n.site_id as site_id', 'ds.sitecode as sitecode', 'n.body as body', 'n.updated_at as updated_at'])
      .orderBy('n.section_key')
      .orderBy('ds.sitecode')
      .execute();
  }

  /** Saves the note for one section and site (site null = every site). An empty body clears it. */
  async saveNote(t: TenantContext, user: AuthedUser, input: HandoverNoteInput) {
    assertCustomerWide(t, 'The Service Handover pack');
    const siteId = input.siteId ?? null;
    const scoped = tenantDb(this.db, t.schema);
    if (siteId) {
      const site = await scoped.selectFrom('discovery_sites').select('id').where('id', '=', siteId).executeTakeFirst();
      if (!site) throw new NotFoundException('site not found');
    }
    const body = input.body.trim();

    if (body === '') {
      let del = scoped.deleteFrom('handover_notes').where('section_key', '=', input.sectionKey);
      del = siteId ? del.where('site_id', '=', siteId) : del.where('site_id', 'is', null);
      await del.execute();
    } else {
      // The unique index is on (section_key, COALESCE(site_id, <zero uuid>)), so
      // this has to be raw SQL to name the expression.
      await sql`
        INSERT INTO ${sql.id(t.schema, 'handover_notes')} (section_key, site_id, body, updated_by)
        VALUES (${input.sectionKey}, ${siteId}, ${body}, ${user.id})
        ON CONFLICT (section_key, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid))
        DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
      `.execute(this.db);
    }

    await this.audit.tenant(t.schema, 'handover.note_saved', {
      actor: { id: user.id, email: user.email },
      targetType: 'handover_note',
      targetId: `${input.sectionKey}:${siteId ?? 'all'}`,
      detail: { sectionKey: input.sectionKey, siteId, cleared: body === '' },
    });
    return { ok: true, cleared: body === '' };
  }

  /* ------------------------------ sections ------------------------------ */

  /**
   * The pack documents what is deployed, not what was asked for. Users, common
   * area phones and resource accounts come from Design & Build, each planned
   * against Discovery's live snapshot with the same diff a deployment uses
   * (planIdentityRows): a row that plans nothing is live and goes in the main
   * table, with the values Teams actually has. Anything that would still
   * change - not created, not found, a different number or policy - is listed
   * under "Designed but Not Yet Live" instead, so the pack never claims what
   * isn't there. Auto attendants and call queues count as live when Teams has
   * one by that name. Numbers show who holds them in Teams.
   */
  private async buildSections(t: TenantContext, scope: SiteScope | null): Promise<{ sections: HandoverSectionData[]; liveAsOf: string | null }> {
    const scoped = tenantDb(this.db, t.schema);
    const bySite = scope !== null;
    const ids = scope?.ids ?? [];
    const codes = scope?.codes ?? [];

    const [sites, phoneNumbers, analogue, voicemailGroups, network, noteRows, lastSync] = await Promise.all([
      scoped
        .selectFrom('discovery_sites')
        .select(['id', 'sitecode', 'name', 'address', 'country', 'region', 'overview'])
        .$if(bySite, (qb) => qb.where('id', 'in', ids))
        .orderBy('sitecode')
        .execute(),

      scoped
        .selectFrom('phone_numbers as pn')
        .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
        .select(['pn.e164 as e164', 'pn.status as status', 'r.sitecode as sitecode', 'r.carrier as carrier'])
        .where((eb) => eb.or([eb('pn.holder_type', 'is', null), eb('pn.holder_type', '!=', 'analogue')]))
        .$if(bySite, (qb) => qb.where('r.sitecode', 'in', codes))
        .orderBy('pn.e164')
        .execute(),

      scoped
        .selectFrom('phone_numbers as pn')
        .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
        .select(['pn.e164 as e164', 'r.sitecode as sitecode', 'pn.note as note'])
        .where('pn.holder_type', '=', 'analogue')
        .$if(bySite, (qb) => qb.where('r.sitecode', 'in', codes))
        .orderBy('pn.e164')
        .execute(),

      // Voicemail groups belong to the tenant, not a site, so a per-site pack still lists them all.
      scoped
        .selectFrom('build_m365_groups')
        .select(['name', 'email', 'members', 'owners'])
        .where('used_for_voicemail', '=', true)
        .orderBy('name')
        .execute(),

      scoped
        .selectFrom('discovery_network as n')
        .leftJoin('discovery_sites as ds', 'ds.id', 'n.site_id')
        .select(['ds.sitecode as sitecode', 'n.scope as scope', 'n.subnet as subnet', 'n.mask as mask', 'n.vlan_id as vlan_id', 'n.network_type as network_type', 'n.location as location'])
        .$if(bySite, (qb) => qb.where('n.site_id', 'in', ids))
        .orderBy('n.subnet')
        .execute(),

      // An all-sites note always applies; a site's note only when that site is in the pack.
      scoped
        .selectFrom('handover_notes as hn')
        .leftJoin('discovery_sites as ds', 'ds.id', 'hn.site_id')
        .select(['hn.section_key as section_key', 'hn.body as body', 'ds.sitecode as sitecode'])
        .$if(bySite, (qb) => qb.where((eb) => eb.or([eb('hn.site_id', 'is', null), eb('hn.site_id', 'in', ids)])))
        .execute(),

      // How fresh "live" is: the last time Discovery read Teams (a sync, a Validate check or a post-deploy check).
      scoped
        .selectFrom('tenant_discovery_runs')
        .select('finished_at')
        .where('status', '=', 'completed')
        .orderBy('finished_at', 'desc')
        .executeTakeFirst(),
    ]);

    const built = await this.asBuilt(t, sites);

    // Who holds each number in Teams right now.
    const liveHolders = await scoped
      .selectFrom('tenant_users')
      .select(['upn', 'display_name', 'account_type', 'line_uri'])
      .where('removed_at', 'is', null)
      .where('line_uri', 'is not', null)
      .execute();
    const holderOf = new Map<string, string>();
    for (const u of liveHolders) {
      const n = lineUriToNumber(u.line_uri);
      if (!n) continue;
      const type = u.account_type === 'ResourceAccount' ? 'Resource account' : 'User';
      holderOf.set(n, `${u.display_name || u.upn} (${type})`);
    }

    // Names of the users picked as Site contact(s), for the site information table.
    const pickedIds = [
      ...new Set(
        sites.flatMap((s) => ((s.overview ?? {}) as DiscoverySiteOverview).contacts?.siteContacts?.map((c) => c.userId).filter((v): v is string => !!v) ?? []),
      ),
    ];
    const contactNames = new Map<string, string>(
      pickedIds.length
        ? (await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', pickedIds).execute()).map((r) => [r.id, r.display_name] as [string, string])
        : [],
    );

    const byKey: Record<string, HandoverSectionContent> = {
      site_information: {
        kind: 'table',
        columns: ['Site code', 'Name', 'Address', 'Country / Region', 'Site contact(s)', 'Target go-live'],
        rows: sites.map((s) => {
          const ov = (s.overview ?? {}) as DiscoverySiteOverview;
          // Picked users by name; typed people as typed. Older overviews only have the one primary contact email.
          const contacts = ov.contacts?.siteContacts ?? (ov.primaryContactEmail ? [{ email: ov.primaryContactEmail }] : []);
          const people = contacts.map((c) => contactLabel(c, c.userId ? contactNames.get(c.userId) : null));
          return [
            s.sitecode,
            s.name ?? '—',
            s.address ?? '—',
            [s.country, s.region].filter(Boolean).join(' / ') || '—',
            people.join(', ') || '—',
            ov.targetGoLive ?? '—',
          ];
        }),
      },

      phone_numbers: {
        kind: 'table',
        columns: ['Number', 'Status', 'Assigned to (in Teams)', 'Site', 'Carrier'],
        rows: phoneNumbers.map((p) => {
          const holder = holderOf.get(p.e164);
          const status = holder ? 'In use' : p.status === 'reserved' ? 'Reserved' : 'Spare';
          return [p.e164, status, holder ?? '—', p.sitecode ?? '—', p.carrier ?? '—'];
        }),
      },

      teams_users: {
        kind: 'table',
        columns: ['UPN', 'Display name', 'Site', 'Number', 'Number type', 'Voice routing policy', 'Calling policy', 'Voicemail', 'Last changed by Voxshift'],
        rows: built.users,
      },

      common_area_phones: {
        kind: 'table',
        columns: ['Display name', 'UPN', 'Number', 'Device model', 'Site', 'Calling policy', 'IP phone policy', 'Last changed by Voxshift'],
        rows: built.caps,
      },

      analogue_phones: {
        kind: 'table',
        columns: ['Number', 'Site', 'Note'],
        rows: analogue.map((a) => [a.e164, a.sitecode ?? '—', a.note ?? '—']),
      },

      auto_attendants: {
        kind: 'table',
        columns: ['Name', 'Site', 'Language', 'Time zone', 'Resource accounts'],
        rows: built.autoAttendants,
      },

      call_queues: {
        kind: 'table',
        columns: ['Name', 'Site', 'Routing method', 'Alert time (s)', 'Agents', 'Overflow', 'Timeout', 'No agents'],
        rows: built.callQueues,
      },

      resource_accounts: {
        kind: 'table',
        columns: ['UPN', 'Display name', 'Kind', 'Site', 'Phone number', 'Voice routing policy', 'Last changed by Voxshift'],
        rows: built.resourceAccounts,
      },

      voicemail_groups: {
        kind: 'table',
        columns: ['Name', 'Email', 'Members', 'Owners'],
        rows: voicemailGroups.map((g) => [g.name, g.email ?? '—', String(jsonArrayLength(g.members)), String(jsonArrayLength(g.owners))]),
      },

      network_data: {
        kind: 'table',
        columns: ['Site', 'Scope', 'Subnet', 'Mask', 'VLAN', 'Type', 'Location'],
        rows: network.map((n) => [
          n.sitecode ?? '—',
          n.scope,
          n.subnet,
          n.mask != null ? String(n.mask) : '—',
          n.vlan_id != null ? String(n.vlan_id) : '—',
          n.network_type ?? '—',
          n.location ?? '—',
        ]),
      },

      not_yet_live: built.notLive.length
        ? { kind: 'table', columns: ['Item', 'Type', 'Site', 'What differs from the design'], rows: built.notLive }
        : { kind: 'placeholder', note: 'Everything designed in Design & Build for these sites is live in Teams.' },
    };

    // The four sections with no structured source are written by hand as notes.
    for (const key of HANDOVER_NOTE_SECTIONS) {
      const notes: HandoverNote[] = noteRows.filter((n) => n.section_key === key).map((n) => ({ sitecode: n.sitecode, body: n.body }));
      byKey[key] = noteSectionContent(key, notes);
    }

    return {
      sections: HANDOVER_SECTIONS.map((s) => ({
        key: s.key,
        title: s.title,
        content: byKey[s.key] ?? { kind: 'placeholder', note: 'No data available for this section.' },
      })),
      liveAsOf: lastSync?.finished_at ? new Date(lastSync.finished_at).toISOString() : null,
    };
  }

  /** Design & Build rows split into what's live (table rows, live values) and what isn't (with why). */
  private async asBuilt(t: TenantContext, sites: { id: string; sitecode: string }[]) {
    const s = tenantDb(this.db, t.schema);
    const users: string[][] = [];
    const caps: string[][] = [];
    const resourceAccounts: string[][] = [];
    const autoAttendants: string[][] = [];
    const callQueues: string[][] = [];
    const notLive: string[][] = [];
    if (sites.length === 0) return { users, caps, resourceAccounts, autoAttendants, callQueues, notLive };
    const siteIds = sites.map((x) => x.id);
    const codeOf = new Map(sites.map((x) => [x.id, x.sitecode]));

    const [userRows, capRows, raRows, aaRows, cqRows, liveNames, capDetails] = await Promise.all([
      s.selectFrom('build_users').select(['id', 'site_id', 'upn', 'number_type', 'revoke_ev', 'voicemail']).where('site_id', 'in', siteIds).where('hidden', '=', false).orderBy('upn').execute(),
      s.selectFrom('build_caps').select(['id', 'site_id', 'upn', 'number_type', 'revoke_ev', 'discovery_cap_id']).where('site_id', 'in', siteIds).where('hidden', '=', false).orderBy('upn').execute(),
      s.selectFrom('build_resource_accounts').select(['id', 'site_id', 'upn', 'display_name', 'kind', 'application_id']).where('site_id', 'in', siteIds).orderBy('display_name').execute(),
      s.selectFrom('build_auto_attendants').select(['name', 'site_id', 'language_id', 'language', 'time_zone_id', 'timezone', 'resource_accounts']).where('site_id', 'in', siteIds).orderBy('name').execute(),
      s.selectFrom('build_call_queues').select(['name', 'site_id', 'routing_method', 'agent_alert_time', 'agents', 'overflow', 'timeout', 'no_agent_action']).where('site_id', 'in', siteIds).orderBy('name').execute(),
      s.selectFrom('tenant_objects').select(['object_type', 'display_name']).where('object_type', 'in', ['auto_attendant', 'call_queue']).where('removed_at', 'is', null).execute(),
      s.selectFrom('discovery_caps').select(['id', 'display_name', 'device_model']).where('site_id', 'in', siteIds).execute(),
    ]);

    // Plan every row against live, per site (the helper is site-scoped).
    const planned = new Map<string, PlannedIdentityRow>();
    for (const siteId of siteIds) {
      for (const p of [
        ...(await planIdentityRows(s, 'build_users', 'user', siteId)),
        ...(await planIdentityRows(s, 'build_caps', 'cap', siteId)),
        ...(await planResourceAccountRows(s, siteId)),
      ]) {
        planned.set(p.id, p);
      }
    }

    const upns = [...userRows, ...capRows, ...raRows].map((r) => r.upn.toLowerCase()).filter(Boolean);
    const displayNames = new Map(
      (upns.length
        ? await s.selectFrom('tenant_users').select(['upn', 'display_name']).where(sql`lower(upn)`, 'in', upns).where('removed_at', 'is', null).execute()
        : []
      ).map((u) => [u.upn.toLowerCase(), u.display_name]),
    );

    // When Voxshift last changed each row live.
    const rowIds = [...userRows, ...capRows, ...raRows].map((r) => r.id);
    const lastChanged = new Map(
      (rowIds.length
        ? await s
            .selectFrom('deployment_changes as dc')
            .innerJoin('deployments as d', 'd.id', 'dc.deployment_id')
            .select(['dc.object_id as object_id', (eb) => eb.fn.max('dc.at').as('at')])
            .where('d.mode', '=', 'execute')
            .where('dc.result', '=', 'applied')
            .where('dc.object_id', 'in', rowIds)
            .groupBy('dc.object_id')
            .execute()
        : []
      ).map((r) => [r.object_id as string, r.at ? new Date(r.at as string).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null]),
    );
    const changedText = (id: string) => lastChanged.get(id) ?? 'Already in place';

    // A row is live when the deployment diff has nothing left to do. Voicemail
    // is only known for accounts a targeted check has read, so "unknown" isn't
    // counted as a difference - it's shown as the designed value, unchecked.
    const differencesOf = (p: PlannedIdentityRow | undefined): string[] => {
      if (!p) return ['Not planned'];
      if (!p.live) return ['Not found in Teams'];
      const live = p.live;
      const calls = p.calls.filter((c) => !(c.cmdlet === 'Set-CsOnlineVoicemailUserSettings' && live.voicemailEnabled === undefined));
      return verificationRowDifferences(calls, live);
    };
    const policy = (live: LiveIdentityState, type: string) => live.policies?.[type] || 'Global';
    const number = (live: LiveIdentityState) => lineUriToNumber(live.lineUri) ?? '—';

    for (const r of userRows) {
      const p = planned.get(r.id);
      const diffs = differencesOf(p);
      if (r.revoke_ev) {
        // A removal: done means Teams calling is off, so the person isn't listed as a Teams Phone user.
        if (diffs.length) notLive.push([r.upn, 'User (remove calling)', codeOf.get(r.site_id) ?? '—', 'Teams calling still to be removed']);
        continue;
      }
      if (diffs.length) {
        notLive.push([r.upn, 'User', codeOf.get(r.site_id) ?? '—', diffs.join('; ')]);
        continue;
      }
      const live = p!.live!;
      const vm = r.voicemail as { enabled?: boolean | null; language?: string | null } | null;
      const voicemail =
        live.voicemailEnabled === undefined
          ? vm?.enabled == null
            ? '—'
            : `${vm.enabled ? 'On' : 'Off'} (designed, not checked live)`
          : live.voicemailEnabled
            ? `On${live.voicemailPromptLanguage ? ` (${live.voicemailPromptLanguage})` : ''}`
            : 'Off';
      users.push([
        r.upn,
        displayNames.get(r.upn.toLowerCase()) ?? '—',
        codeOf.get(r.site_id) ?? '—',
        number(live),
        r.number_type ?? '—',
        policy(live, 'OnlineVoiceRoutingPolicy'),
        policy(live, 'TeamsCallingPolicy'),
        voicemail,
        changedText(r.id),
      ]);
    }

    const capInfo = new Map(capDetails.map((c) => [c.id, c]));
    for (const r of capRows) {
      const p = planned.get(r.id);
      const diffs = differencesOf(p);
      if (r.revoke_ev) {
        if (diffs.length) notLive.push([r.upn, 'Common area phone (remove calling)', codeOf.get(r.site_id) ?? '—', 'Teams calling still to be removed']);
        continue;
      }
      if (diffs.length) {
        notLive.push([r.upn, 'Common area phone', codeOf.get(r.site_id) ?? '—', diffs.join('; ')]);
        continue;
      }
      const live = p!.live!;
      const info = r.discovery_cap_id ? capInfo.get(r.discovery_cap_id) : undefined;
      caps.push([
        info?.display_name ?? displayNames.get(r.upn.toLowerCase()) ?? r.upn,
        r.upn,
        number(live),
        info?.device_model ?? '—',
        codeOf.get(r.site_id) ?? '—',
        policy(live, 'TeamsCallingPolicy'),
        policy(live, 'TeamsIPPhonePolicy'),
        changedText(r.id),
      ]);
    }

    for (const r of raRows) {
      const p = planned.get(r.id);
      const diffs = !r.application_id || !r.upn ? ['Not created yet'] : differencesOf(p);
      const kind = r.kind === 'auto_attendant' ? 'Auto Attendant' : 'Call Queue';
      if (diffs.length) {
        notLive.push([r.upn || r.display_name || '—', `Resource account (${kind})`, codeOf.get(r.site_id) ?? '—', diffs.join('; ')]);
        continue;
      }
      const live = p!.live!;
      resourceAccounts.push([
        r.upn,
        r.display_name ?? '—',
        kind,
        codeOf.get(r.site_id) ?? '—',
        number(live),
        policy(live, 'OnlineVoiceRoutingPolicy'),
        changedText(r.id),
      ]);
    }

    const liveAa = new Set(liveNames.filter((o) => o.object_type === 'auto_attendant').map((o) => (o.display_name ?? '').toLowerCase()));
    const liveCq = new Set(liveNames.filter((o) => o.object_type === 'call_queue').map((o) => (o.display_name ?? '').toLowerCase()));
    for (const a of aaRows) {
      if (!liveAa.has(a.name.toLowerCase())) {
        notLive.push([a.name, 'Auto attendant', codeOf.get(a.site_id) ?? '—', 'Not found in Teams']);
        continue;
      }
      autoAttendants.push([
        a.name,
        codeOf.get(a.site_id) ?? '—',
        a.language_id ?? a.language ?? '—',
        a.time_zone_id ?? a.timezone ?? '—',
        String(jsonArrayLength(a.resource_accounts)),
      ]);
    }
    for (const q of cqRows) {
      if (!liveCq.has(q.name.toLowerCase())) {
        notLive.push([q.name, 'Call queue', codeOf.get(q.site_id) ?? '—', 'Not found in Teams']);
        continue;
      }
      // Agent names, not just a count - the customer needs to know who answers.
      const agents = Array.isArray(q.agents) ? (q.agents as string[]) : [];
      const agentText = agents.length ? `${agents.slice(0, 10).join(', ')}${agents.length > 10 ? ` and ${agents.length - 10} more` : ''}` : 'None';
      callQueues.push([
        q.name,
        codeOf.get(q.site_id) ?? '—',
        q.routing_method,
        String(q.agent_alert_time),
        agentText,
        targetSummary(q.overflow as { action?: string; threshold?: number; target?: string | null } | null),
        targetSummary(q.timeout as { action?: string; threshold?: number; target?: string | null } | null),
        targetSummary(q.no_agent_action as { action?: string; threshold?: number; target?: string | null } | null),
      ]);
    }

    return { users, caps, resourceAccounts, autoAttendants, callQueues, notLive };
  }
}
