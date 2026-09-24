import { Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { HANDOVER_SECTIONS, type DiscoverySiteOverview } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { FilesService } from '../files/files.service';
import { HandoverDocumentService, type HandoverSectionContent, type HandoverSectionData } from './handover-document.service';

const HOLDER_TYPE_LABEL: Record<string, string> = {
  user: 'User',
  cap: 'Common area phone',
  resource_account: 'Resource account',
};

/**
 * These four Handover sections have no structured data source anywhere in
 * Voxshift today (confirmed by grepping for real usage, not just a matching
 * column name) - they render as a placeholder callout in the generated
 * .docx instead of a fabricated table, until a future feature adds one.
 */
const PLACEHOLDER_NOTE: Record<string, string> = {
  service_support_model: 'Not yet captured in Voxshift — agree the ongoing support model with the customer and add it to this section manually.',
  paging: 'No paging system data is currently collected by Voxshift.',
  teams_configuration: 'Not yet captured in Voxshift — record tenant-wide Microsoft Teams configuration decisions in this section manually.',
  outstanding_actions: 'No outstanding actions recorded for this handover.',
};

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

  list(t: TenantContext) {
    return tenantDb(this.db, t.schema)
      .selectFrom('handover_packs')
      .select(['id', 'version', 'status', 'generated_by', 'generated_at', 'file_id', 'created_at'])
      .orderBy('version', 'desc')
      .execute();
  }

  async get(t: TenantContext, id: string) {
    const scoped = tenantDb(this.db, t.schema);
    const [pack, sections] = await Promise.all([
      scoped.selectFrom('handover_packs').selectAll().where('id', '=', id).executeTakeFirst(),
      scoped.selectFrom('handover_sections').selectAll().where('pack_id', '=', id).orderBy('ordinal').execute(),
    ]);
    if (!pack) throw new NotFoundException('handover pack not found');
    return { pack, sections };
  }

  async generate(t: TenantContext, user: AuthedUser, body: { notes?: string }) {
    const scoped = tenantDb(this.db, t.schema);
    const last = await scoped
      .selectFrom('handover_packs')
      .select((eb) => eb.fn.max('version').as('v'))
      .executeTakeFirst();
    const version = Number(last?.v ?? 0) + 1;

    const sections = await this.buildSections(t);
    const generatedAt = new Date();

    const data = await this.documentBuilder.build({
      tenantName: t.name,
      version,
      generatedBy: user.displayName,
      generatedAt,
      sections,
    });

    const pack = await scoped
      .insertInto('handover_packs')
      .values({
        version,
        status: 'draft',
        generated_by: user.id,
        generated_at: generatedAt.toISOString(),
        source: { notes: body.notes ?? null, snapshotAt: generatedAt.toISOString() },
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const file = await this.files.store(t, {
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

    const updated = await scoped
      .updateTable('handover_packs')
      .set({ file_id: file.id })
      .where('id', '=', pack.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await scoped
      .insertInto('handover_sections')
      .values(sections.map((s, i) => ({ pack_id: pack.id, key: s.key, title: s.title, ordinal: i, content: s.content })))
      .execute();

    await this.audit.tenant(t.schema, 'handover.pack_generated', {
      actor: { id: user.id, email: user.email },
      targetType: 'handover_pack',
      targetId: pack.id,
      detail: { version, fileId: file.id },
    });

    return { ...updated, sections: sections.length };
  }

  private async buildSections(t: TenantContext): Promise<HandoverSectionData[]> {
    const scoped = tenantDb(this.db, t.schema);

    const [sites, phoneNumbers, users, caps, analogue, autoAttendants, callQueues, resourceAccounts, voicemailGroups, network] =
      await Promise.all([
        scoped.selectFrom('discovery_sites').select(['sitecode', 'name', 'address', 'country', 'region', 'overview']).orderBy('sitecode').execute(),

        scoped
          .selectFrom('phone_numbers as pn')
          .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
          .select(['pn.e164 as e164', 'pn.status as status', 'pn.holder_type as holder_type', 'r.sitecode as sitecode', 'r.carrier as carrier'])
          .where((eb) => eb.or([eb('pn.holder_type', 'is', null), eb('pn.holder_type', '!=', 'analogue')]))
          .orderBy('pn.e164')
          .execute(),

        scoped
          .selectFrom('discovery_users as du')
          .leftJoin('tenant_policies as tp', 'tp.id', 'du.calling_policy_id')
          .leftJoin('discovery_sites as ds', 'ds.id', 'du.site_id')
          .select(['du.upn as upn', 'du.display_name as display_name', 'ds.sitecode as sitecode', 'tp.name as policy_name', 'du.caller_id as caller_id', 'du.voicemail_enabled as voicemail_enabled'])
          .orderBy('du.upn')
          .execute(),

        scoped
          .selectFrom('discovery_caps as dc')
          .leftJoin('tenant_policies as tp', 'tp.id', 'dc.calling_policy_id')
          .leftJoin('discovery_sites as ds', 'ds.id', 'dc.site_id')
          .select(['dc.display_name as display_name', 'dc.upn as upn', 'dc.device_model as device_model', 'ds.sitecode as sitecode', 'tp.name as policy_name'])
          .orderBy('dc.display_name')
          .execute(),

        scoped
          .selectFrom('phone_numbers as pn')
          .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
          .select(['pn.e164 as e164', 'r.sitecode as sitecode', 'pn.note as note'])
          .where('pn.holder_type', '=', 'analogue')
          .orderBy('pn.e164')
          .execute(),

        scoped
          .selectFrom('build_auto_attendants as aa')
          .innerJoin('discovery_sites as ds', 'ds.id', 'aa.site_id')
          .select(['aa.name as name', 'ds.sitecode as sitecode', 'aa.language_id as language_id', 'aa.language as language', 'aa.time_zone_id as time_zone_id', 'aa.timezone as timezone', 'aa.resource_accounts as resource_accounts'])
          .orderBy('aa.name')
          .execute(),

        scoped
          .selectFrom('build_call_queues as cq')
          .innerJoin('discovery_sites as ds', 'ds.id', 'cq.site_id')
          .select(['cq.name as name', 'ds.sitecode as sitecode', 'cq.routing_method as routing_method', 'cq.agent_alert_time as agent_alert_time', 'cq.agents as agents', 'cq.overflow as overflow', 'cq.timeout as timeout', 'cq.no_agent_action as no_agent_action'])
          .orderBy('cq.name')
          .execute(),

        scoped
          .selectFrom('build_resource_accounts as ra')
          .innerJoin('discovery_sites as ds', 'ds.id', 'ra.site_id')
          .select(['ra.upn as upn', 'ra.display_name as display_name', 'ra.kind as kind', 'ds.sitecode as sitecode', 'ra.phone_number as phone_number'])
          .orderBy('ra.upn')
          .execute(),

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
          .orderBy('n.subnet')
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

    for (const [key, note] of Object.entries(PLACEHOLDER_NOTE)) {
      byKey[key] = { kind: 'placeholder', note };
    }

    return HANDOVER_SECTIONS.map((s) => ({
      key: s.key,
      title: s.title,
      content: byKey[s.key] ?? { kind: 'placeholder', note: 'No data available for this section.' },
    }));
  }
}
