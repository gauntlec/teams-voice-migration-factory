import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { tenantDb } from '@tvmf/db';
import {
  HANDOVER_NOTE_SECTIONS,
  HANDOVER_SECTIONS,
  handoverScopeLabel,
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

const HOLDER_TYPE_LABEL: Record<string, string> = {
  user: 'User',
  cap: 'Common area phone',
  resource_account: 'Resource account',
};

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
  list(t: TenantContext) {
    assertCustomerWide(t, 'The Service Handover pack');
    return tenantDb(this.db, t.schema)
      .selectFrom('handover_packs')
      .select(['id', 'version', 'status', 'generated_by', 'generated_at', 'file_id', 'issued_by', 'issued_at', 'source', 'created_at'])
      .orderBy('version', 'desc')
      .execute();
  }

  async get(t: TenantContext, id: string) {
    assertCustomerWide(t, 'The Service Handover pack');
    const scoped = tenantDb(this.db, t.schema);
    const [pack, sections] = await Promise.all([
      scoped.selectFrom('handover_packs').selectAll().where('id', '=', id).executeTakeFirst(),
      scoped.selectFrom('handover_sections').selectAll().where('pack_id', '=', id).orderBy('ordinal').execute(),
    ]);
    if (!pack) throw new NotFoundException('handover pack not found');
    return { pack, sections };
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
    const sections = selectSections(await this.buildSections(t, scope), body.sectionKeys);
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

    // Guarded on status so two people issuing at once cannot both succeed.
    const updated = await scoped
      .updateTable('handover_packs')
      .set({ status: 'issued', issued_by: user.id, issued_at: new Date().toISOString() })
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

  private async buildSections(t: TenantContext, scope: SiteScope | null): Promise<HandoverSectionData[]> {
    const scoped = tenantDb(this.db, t.schema);
    const bySite = scope !== null;
    const ids = scope?.ids ?? [];
    const codes = scope?.codes ?? [];

    const [sites, phoneNumbers, users, caps, analogue, autoAttendants, callQueues, resourceAccounts, voicemailGroups, network, noteRows] =
      await Promise.all([
        scoped
          .selectFrom('discovery_sites')
          .select(['sitecode', 'name', 'address', 'country', 'region', 'overview'])
          .$if(bySite, (qb) => qb.where('id', 'in', ids))
          .orderBy('sitecode')
          .execute(),

        scoped
          .selectFrom('phone_numbers as pn')
          .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
          .select(['pn.e164 as e164', 'pn.status as status', 'pn.holder_type as holder_type', 'r.sitecode as sitecode', 'r.carrier as carrier'])
          .where((eb) => eb.or([eb('pn.holder_type', 'is', null), eb('pn.holder_type', '!=', 'analogue')]))
          .$if(bySite, (qb) => qb.where('r.sitecode', 'in', codes))
          .orderBy('pn.e164')
          .execute(),

        scoped
          .selectFrom('discovery_users as du')
          .leftJoin('tenant_policies as tp', 'tp.id', 'du.calling_policy_id')
          .leftJoin('discovery_sites as ds', 'ds.id', 'du.site_id')
          .select(['du.upn as upn', 'du.display_name as display_name', 'ds.sitecode as sitecode', 'tp.name as policy_name', 'du.caller_id as caller_id', 'du.voicemail_enabled as voicemail_enabled'])
          .$if(bySite, (qb) => qb.where('ds.id', 'in', ids))
          .orderBy('du.upn')
          .execute(),

        scoped
          .selectFrom('discovery_caps as dc')
          .leftJoin('tenant_policies as tp', 'tp.id', 'dc.calling_policy_id')
          .leftJoin('discovery_sites as ds', 'ds.id', 'dc.site_id')
          .select(['dc.display_name as display_name', 'dc.upn as upn', 'dc.device_model as device_model', 'ds.sitecode as sitecode', 'tp.name as policy_name'])
          .$if(bySite, (qb) => qb.where('ds.id', 'in', ids))
          .orderBy('dc.display_name')
          .execute(),

        scoped
          .selectFrom('phone_numbers as pn')
          .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
          .select(['pn.e164 as e164', 'r.sitecode as sitecode', 'pn.note as note'])
          .where('pn.holder_type', '=', 'analogue')
          .$if(bySite, (qb) => qb.where('r.sitecode', 'in', codes))
          .orderBy('pn.e164')
          .execute(),

        scoped
          .selectFrom('build_auto_attendants as aa')
          .innerJoin('discovery_sites as ds', 'ds.id', 'aa.site_id')
          .select(['aa.name as name', 'ds.sitecode as sitecode', 'aa.language_id as language_id', 'aa.language as language', 'aa.time_zone_id as time_zone_id', 'aa.timezone as timezone', 'aa.resource_accounts as resource_accounts'])
          .$if(bySite, (qb) => qb.where('ds.id', 'in', ids))
          .orderBy('aa.name')
          .execute(),

        scoped
          .selectFrom('build_call_queues as cq')
          .innerJoin('discovery_sites as ds', 'ds.id', 'cq.site_id')
          .select(['cq.name as name', 'ds.sitecode as sitecode', 'cq.routing_method as routing_method', 'cq.agent_alert_time as agent_alert_time', 'cq.agents as agents', 'cq.overflow as overflow', 'cq.timeout as timeout', 'cq.no_agent_action as no_agent_action'])
          .$if(bySite, (qb) => qb.where('ds.id', 'in', ids))
          .orderBy('cq.name')
          .execute(),

        scoped
          .selectFrom('build_resource_accounts as ra')
          .innerJoin('discovery_sites as ds', 'ds.id', 'ra.site_id')
          .select(['ra.upn as upn', 'ra.display_name as display_name', 'ra.kind as kind', 'ds.sitecode as sitecode', 'ra.phone_number as phone_number'])
          .$if(bySite, (qb) => qb.where('ds.id', 'in', ids))
          .orderBy('ra.upn')
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
      ]);

    const byKey: Record<string, HandoverSectionContent> = {
      site_information: {
        kind: 'table',
        columns: ['Site code', 'Name', 'Address', 'Country / Region', 'Primary contact', 'Target go-live'],
        rows: sites.map((s) => {
          const ov = (s.overview ?? {}) as DiscoverySiteOverview;
          return [
            s.sitecode,
            s.name ?? '—',
            s.address ?? '—',
            [s.country, s.region].filter(Boolean).join(' / ') || '—',
            ov.primaryContactEmail ?? '—',
            ov.targetGoLive ?? '—',
          ];
        }),
      },

      phone_numbers: {
        kind: 'table',
        columns: ['Number', 'Status', 'Assigned to', 'Site', 'Carrier'],
        rows: phoneNumbers.map((p) => [
          p.e164,
          p.status,
          p.holder_type ? (HOLDER_TYPE_LABEL[p.holder_type] ?? p.holder_type) : 'Unassigned',
          p.sitecode ?? '—',
          p.carrier ?? '—',
        ]),
      },

      teams_users: {
        kind: 'table',
        columns: ['UPN', 'Display name', 'Site', 'Calling policy', 'Caller ID', 'Voicemail'],
        rows: users.map((u) => [
          u.upn,
          u.display_name ?? '—',
          u.sitecode ?? '—',
          u.policy_name ?? '—',
          u.caller_id ?? '—',
          u.voicemail_enabled ? 'Enabled' : 'Disabled',
        ]),
      },

      common_area_phones: {
        kind: 'table',
        columns: ['Display name', 'UPN', 'Device model', 'Site', 'Calling policy'],
        rows: caps.map((c) => [c.display_name, c.upn ?? '—', c.device_model ?? '—', c.sitecode ?? '—', c.policy_name ?? '—']),
      },

      analogue_phones: {
        kind: 'table',
        columns: ['Number', 'Site', 'Note'],
        rows: analogue.map((a) => [a.e164, a.sitecode ?? '—', a.note ?? '—']),
      },

      auto_attendants: {
        kind: 'table',
        columns: ['Name', 'Site', 'Language', 'Time zone', 'Resource accounts'],
        rows: autoAttendants.map((a) => [
          a.name,
          a.sitecode,
          a.language_id ?? a.language ?? '—',
          a.time_zone_id ?? a.timezone ?? '—',
          String(jsonArrayLength(a.resource_accounts)),
        ]),
      },

      call_queues: {
        kind: 'table',
        columns: ['Name', 'Site', 'Routing method', 'Alert time (s)', 'Agents', 'Overflow', 'Timeout', 'No agents'],
        rows: callQueues.map((q) => [
          q.name,
          q.sitecode,
          q.routing_method,
          String(q.agent_alert_time),
          String(jsonArrayLength(q.agents)),
          targetSummary(q.overflow as { action?: string; threshold?: number; target?: string | null } | null),
          targetSummary(q.timeout as { action?: string; threshold?: number; target?: string | null } | null),
          targetSummary(q.no_agent_action as { action?: string; threshold?: number; target?: string | null } | null),
        ]),
      },

      resource_accounts: {
        kind: 'table',
        columns: ['UPN', 'Display name', 'Kind', 'Site', 'Phone number'],
        rows: resourceAccounts.map((r) => [
          r.upn,
          r.display_name ?? '—',
          r.kind === 'auto_attendant' ? 'Auto Attendant' : 'Call Queue',
          r.sitecode,
          r.phone_number ?? '—',
        ]),
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
    };

    // The four sections with no structured source are written by hand as notes.
    for (const key of HANDOVER_NOTE_SECTIONS) {
      const notes: HandoverNote[] = noteRows.filter((n) => n.section_key === key).map((n) => ({ sitecode: n.sitecode, body: n.body }));
      byKey[key] = noteSectionContent(key, notes);
    }

    return HANDOVER_SECTIONS.map((s) => ({
      key: s.key,
      title: s.title,
      content: byKey[s.key] ?? { kind: 'placeholder', note: 'No data available for this section.' },
    }));
  }
}
