import { BadRequestException, ConflictException, Injectable, Optional, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { planIdentityRows, planResourceAccountRows, platformDb, tenantDb, type PlannedIdentityRow } from '@tvmf/db';
import {
  buildAutoAttendantFlowGraphFromLive,
  can,
  contactLabel,
  type CallFlowGraph,
  type CallFlowResourceAccount,
  HANDOVER_NOTE_SECTIONS,
  HANDOVER_SECTIONS,
  handoverScopeLabel,
  lineUriToNumber,
  verificationRowDifferences,
  type LiveIdentityState,
  noteSectionContent,
  nextHandoverVersionLabel,
  issuedHandoverVersionLabel,
  handoverFileName,
  sameHandoverScope,
  outstandingActionsContent,
  type HandoverApproval,
  type HandoverHistoryRow,
  selectSections,
  type HandoverBlock,
  type DiscoverySiteOverview,
  type HandoverNote,
  type HandoverNoteSection,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { DocumentBrandingService } from '../branding/document-branding.service';
import { InjectDb, type Db } from '../../db/db.module';
import { assertCustomerWide } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';
import { HandoverDocumentService, type HandoverSectionContent, type HandoverSectionData } from './handover-document.service';

/** What a pack covers: the sites chosen (empty = every site) and the section keys chosen (empty = every section). */
export interface HandoverGenerateInput {
  notes?: string;
  /** what changed in this version (Document Control's Comments) */
  changeNote?: string;
  /** call flow diagrams uploaded for this pack, one per auto attendant */
  diagrams?: PackDiagram[];
  /** the cover's project line; the last pack's when not given */
  projectName?: string;
  siteIds?: string[];
  sectionKeys?: string[];
}

export interface PackDiagram {
  name: string;
  fileId: string;
  width: number;
  height: number;
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

/** "5 November 2026" - the pack's dates. */
const handoverDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** US Letter when every site in the pack is in the US or Canada, A4 otherwise (the template is Letter for US sites). */
const LETTER_COUNTRIES = /^(us|usa|united states( of america)?|ca|can|canada)$/i;

/** What the cover and page set-up need beyond the sections: the project line, the site line, the paper size. */
interface PackLayout {
  projectName: string | null;
  siteLabel: string;
  pageSize: 'letter' | 'a4';
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
    /** whose branding packs carry (docs/BRANDING.md); optional so tests can leave it out (Voxshift's) */
    @Optional() private readonly branding?: DocumentBrandingService,
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
      .select(['id', 'version', 'version_label', 'status', 'generated_by', 'generated_at', 'file_id', 'issued_by', 'issued_at', 'source', 'created_at'])
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

  /**
   * The call flows to draw for a pack: what Teams has (Discovery's last read), as this is the as-built document. One graph per auto
   * attendant the sites have that is live, starting from those with a phone number and leaving out one already inside another's
   * graph (a Main Number's graph follows its transfers, so its Overflow attendant is on the same picture). Built here because the
   * names of a queue's agents need the whole user list, which is far too big to send to a browser on a large tenant.
   */
  async callFlowGraphs(t: TenantContext, siteIds?: string[]): Promise<{ name: string; graph: CallFlowGraph }[]> {
    assertCustomerWide(t, 'The Service Handover pack');
    const s = tenantDb(this.db, t.schema);
    const scope = await this.resolveScope(t, siteIds);
    const designed = await s
      .selectFrom('build_auto_attendants')
      .select('name')
      .$if(!!scope, (q) => q.where('site_id', 'in', scope!.ids))
      .execute();
    if (designed.length === 0) return [];
    const wanted = new Set(designed.map((a) => a.name.toLowerCase()));
    const objects = await s.selectFrom('tenant_objects').select(['object_type', 'object_key', 'display_name', 'data']).where('object_type', 'in', ['auto_attendant', 'call_queue', 'schedule', 'resource_account']).where('removed_at', 'is', null).execute();
    const live = (type: string) => objects.filter((o) => o.object_type === type).map((o) => ({ name: o.display_name ?? o.object_key, data: (o.data ?? {}) as Record<string, unknown> }));
    const autoAttendants = live('auto_attendant');
    const callQueues = live('call_queue');
    const schedules = objects.filter((o) => o.object_type === 'schedule').map((o) => ({ key: o.object_key, data: (o.data ?? {}) as Record<string, unknown> }));
    const resourceAccounts = new Map<string, CallFlowResourceAccount>(
      objects
        .filter((o) => o.object_type === 'resource_account')
        .map((o) => {
          const d = (o.data ?? {}) as Record<string, unknown>;
          return [o.object_key.toLowerCase(), { name: o.display_name ?? null, upn: typeof d.UserPrincipalName === 'string' ? d.UserPrincipalName : null, number: typeof d.PhoneNumber === 'string' && d.PhoneNumber ? d.PhoneNumber : null }];
        }),
    );
    // Agents and transfer targets are Entra ids. A user since removed from the sync still has a name, better than a shortened id; a current one wins.
    const users = await s.selectFrom('tenant_users').select(['entra_id', 'upn', 'removed_at']).where('entra_id', 'is not', null).orderBy(sql`removed_at is null`).execute();
    const usersByEntraId = new Map(users.map((u) => [u.entra_id!.toLowerCase(), u.upn]));

    const hasNumber = (data: Record<string, unknown>) => (Array.isArray(data.ApplicationInstances) ? (data.ApplicationInstances as unknown[]) : []).some((id) => typeof id === 'string' && !!resourceAccounts.get(id.toLowerCase())?.number);
    const ordered = autoAttendants
      .filter((a) => wanted.has(a.name.toLowerCase()))
      .sort((a, b) => Number(hasNumber(b.data)) - Number(hasNumber(a.data)) || a.name.localeCompare(b.name));
    const drawn = new Set<string>();
    const out: { name: string; graph: CallFlowGraph }[] = [];
    for (const aa of ordered) {
      const identity = typeof aa.data.Identity === 'string' ? aa.data.Identity.toLowerCase() : null;
      if (identity && drawn.has(identity)) continue;
      const graph = buildAutoAttendantFlowGraphFromLive(aa, autoAttendants, callQueues, schedules, usersByEntraId, resourceAccounts);
      for (const n of graph.nodes) if (n.id.startsWith('aa:')) drawn.add(n.id.slice('aa:'.length).toLowerCase());
      if (graph.nodes.length) out.push({ name: aa.name, graph });
    }
    return out;
  }

  /** Keeps a call flow diagram the browser drew for a pack it is about to generate. Only a PNG is accepted. */
  async uploadDiagram(t: TenantContext, user: AuthedUser, file: { originalname: string; buffer: Buffer } | undefined) {
    assertCustomerWide(t, 'The Service Handover pack');
    if (!file) throw new BadRequestException('Choose a diagram to upload.');
    if (file.buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new BadRequestException('A call flow diagram must be a PNG picture.');
    const stored = await this.files.store(t, {
      category: 'handover_diagram',
      sourceType: 'handover_diagram',
      sourceId: randomUUID(),
      siteId: null,
      filename: file.originalname || 'call-flow.png',
      contentType: 'image/png',
      data: file.buffer,
      uploadedBy: user.id,
    });
    return { fileId: stored.id };
  }

  /** The diagrams named in a generate request that really are this customer's stored diagrams. */
  private async knownDiagrams(t: TenantContext, diagrams: PackDiagram[] | undefined): Promise<PackDiagram[]> {
    if (!diagrams?.length) return [];
    const rows = await tenantDb(this.db, t.schema).selectFrom('files').select('id').where('category', '=', 'handover_diagram').where('id', 'in', diagrams.map((d) => d.fileId)).execute();
    const known = new Set(rows.map((r) => r.id));
    return diagrams.filter((d) => known.has(d.fileId));
  }

  /** The bytes of the pictures a pack's sections name, for the document. One that can't be read is left out, never failing the pack. */
  private async packImages(t: TenantContext, sections: { content: HandoverSectionContent }[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    for (const sec of sections) {
      if (sec.content.kind !== 'blocks') continue;
      for (const b of sec.content.blocks) {
        if (b.kind !== 'image' || out.has(b.fileId)) continue;
        try {
          out.set(b.fileId, (await this.files.readBytes(t, b.fileId)).data);
        } catch {
          // drawn without it: the document says the diagram isn't available
        }
      }
    }
    return out;
  }

  /**
   * The cover's site line (one site's name, else "All sites" or the site codes) and the paper size, from the pack's sites;
   * the project line as given, else the last pack's.
   */
  private async packLayout(t: TenantContext, scope: SiteScope | null, projectName: string | undefined): Promise<PackLayout> {
    const s = tenantDb(this.db, t.schema);
    let q = s.selectFrom('discovery_sites').select(['sitecode', 'name', 'country']);
    if (scope) q = q.where('id', 'in', scope.ids);
    const sites = await q.execute();
    const siteLabel = sites.length === 1 ? sites[0]!.name || sites[0]!.sitecode : scope ? handoverScopeLabel(scope.codes) : 'All sites';
    const pageSize = sites.length > 0 && sites.every((x) => x.country && LETTER_COUNTRIES.test(x.country.trim())) ? 'letter' : 'a4';
    let project = projectName?.trim() || null;
    if (projectName === undefined) {
      const last = await s.selectFrom('handover_packs').select('source').orderBy('version', 'desc').limit(1).executeTakeFirst();
      project = ((last?.source ?? {}) as { projectName?: string | null }).projectName ?? null;
    }
    return { projectName: project, siteLabel, pageSize };
  }

  async generate(t: TenantContext, user: AuthedUser, body: HandoverGenerateInput) {
    assertCustomerWide(t, 'The Service Handover pack');
    const scoped = tenantDb(this.db, t.schema);
    const scope = await this.resolveScope(t, body.siteIds);
    const layout = await this.packLayout(t, scope, body.projectName);
    const customerLogo = (await this.branding?.customerLogo(t.id)) ?? null;
    // Sections are read before the transaction so the lock is held only for the writes.
    const brand = await this.branding?.forDocuments(t.id);
    const built = await this.buildSections(t, scope, brand?.name, await this.knownDiagrams(t, body.diagrams));
    const sections = selectSections(built.sections, body.sectionKeys);
    if (sections.length === 0) throw new BadRequestException('Choose at least one section for the pack.');
    const generatedAt = new Date();
    const packId = randomUUID();
    const scopeLabel = handoverScopeLabel(scope?.codes);

    // The version read and the pack + section inserts share one transaction under
    // an advisory lock, so two concurrent Generate requests can't both take the
    // same max(version) + 1, and a failed insert can't leave a half-written pack.
    const { pack, version, versionLabel, data } = await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${t.schema} || ':handover_pack'))`.execute(trx);
      const s = tenantDb(trx, t.schema);
      const last = await s.selectFrom('handover_packs').select((eb) => eb.fn.max('version').as('v')).executeTakeFirst();
      const version = Number(last?.v ?? 0) + 1;
      const versionLabel = nextHandoverVersionLabel(await this.packsForSites(s, scope?.ids ?? []));
      const history = await this.historyRows(s, scope?.ids ?? [], version, {
        author: user.displayName,
        version: `${versionLabel} (draft)`,
        date: handoverDate(generatedAt),
        comments: body.changeNote?.trim() || 'Draft for review',
      });

      const data = await this.documentBuilder.build({
        brand,
        images: await this.packImages(t, sections),
        customerLogo,
        ...layout,
        tenantName: t.name,
        version,
        versionLabel,
        history,
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
          version_label: versionLabel,
          status: 'draft',
          generated_by: user.id,
          generated_at: generatedAt.toISOString(),
          source: {
            notes: body.notes ?? null,
            changeNote: body.changeNote?.trim() || null,
            // the cover's project and site lines and the paper size, so issuing draws the same front page
            ...layout,
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

      return { pack, version, versionLabel, data };
    });

    let file;
    try {
      file = await this.files.store(t, {
        category: 'handover_pack',
        sourceType: 'handover_pack',
        sourceId: pack.id,
        siteId: null,
        filename: handoverFileName(scope?.codes, versionLabel),
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
  async issue(t: TenantContext, user: AuthedUser, id: string, body: { approverCompany?: string; approverName?: string; approvalDate?: string } = {}) {
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
    const source = (full.source ?? {}) as { siteCodes?: string[]; siteIds?: string[]; liveAsOf?: string | null; changeNote?: string | null } & Partial<PackLayout>;
    const brand = await this.branding?.forDocuments(t.id);
    const versionLabel = issuedHandoverVersionLabel(full.version_label, await this.packsForSites(scoped, source.siteIds ?? []));
    // Approvals & Sign-Off: who approved it, as entered when issuing (the company defaults to the pack's brand)
    const approval: HandoverApproval = {
      company: body.approverCompany?.trim() || brand?.name || 'Voxshift',
      name: body.approverName?.trim() || '',
      date: body.approvalDate ?? issuedAt.toISOString().slice(0, 10),
    };
    const history = await this.historyRows(scoped, source.siteIds ?? [], full.version, {
      author: author?.display_name ?? 'Voxshift',
      version: versionLabel,
      date: handoverDate(issuedAt),
      comments: source.changeNote || 'Issued',
    });
    const data = await this.documentBuilder.build({
      brand,
      images: await this.packImages(
        t,
        savedSections.map((sec) => ({ content: sec.content as HandoverSectionContent })),
      ),
      versionLabel,
      approval,
      history,
      customerLogo: (await this.branding?.customerLogo(t.id)) ?? null,
      projectName: source.projectName ?? null,
      siteLabel: source.siteLabel ?? handoverScopeLabel(source.siteCodes),
      pageSize: source.pageSize ?? 'a4',
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
      filename: handoverFileName(source.siteCodes, versionLabel),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data,
      uploadedBy: user.id,
      metadata: { version: full.version, versionLabel, issued: true },
    });

    // Guarded on status so two people issuing at once cannot both succeed.
    const updated = await scoped
      .updateTable('handover_packs')
      .set({ status: 'issued', issued_by: user.id, issued_at: issuedAt.toISOString(), file_id: file.id, version_label: versionLabel, source: JSON.stringify({ ...source, approval }) as never })
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This pack was just issued by someone else.');

    await this.audit.tenant(t.schema, 'handover.pack_issued', {
      actor: { id: user.id, email: user.email },
      targetType: 'handover_pack',
      targetId: id,
      detail: { version: pack.version, versionLabel, approval },
    });
    return updated;
  }

  /**
   * Document Control: the customer's earlier packs covering the same sites, oldest first, then this one. Each row is who
   * generated it, its version (a draft says so), when, and what changed (the note given when generating).
   */
  /** The packs for exactly these sites: each site's packs have their own version numbers. */
  private async packsForSites(s: ReturnType<typeof tenantDb>, siteIds: string[]) {
    const packs = await s.selectFrom('handover_packs').select(['status', 'version_label', 'source']).execute();
    return packs.filter((p) => sameHandoverScope(((p.source ?? {}) as { siteIds?: string[] }).siteIds, siteIds));
  }

  private async historyRows(s: ReturnType<typeof tenantDb>, siteIds: string[], version: number, current: HandoverHistoryRow): Promise<HandoverHistoryRow[]> {
    const rows = (await s.selectFrom('handover_packs').select(['version', 'version_label', 'status', 'generated_by', 'generated_at', 'issued_at', 'created_at', 'source']).where('version', '<', version).orderBy('version').execute()).filter((r) =>
      sameHandoverScope(((r.source ?? {}) as { siteIds?: string[] }).siteIds, siteIds),
    );
    const ids = [...new Set(rows.map((r) => r.generated_by))];
    const names = new Map(ids.length ? (await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', ids).execute()).map((u) => [u.id, u.display_name] as [string, string]) : []);
    return [
      ...rows.map((r) => {
        const src = (r.source ?? {}) as { changeNote?: string | null };
        const issued = r.status === 'issued';
        return {
          author: names.get(r.generated_by) ?? 'Voxshift',
          version: `${r.version_label ?? r.version}${issued ? '' : ' (draft)'}`,
          date: handoverDate(new Date(r.issued_at ?? r.generated_at ?? r.created_at)),
          comments: src.changeNote || (issued ? 'Issued' : 'Draft for review'),
        };
      }),
      current,
    ];
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
  private async buildSections(t: TenantContext, scope: SiteScope | null, brandName = 'Voxshift', diagrams: PackDiagram[] = []): Promise<{ sections: HandoverSectionData[]; liveAsOf: string | null }> {
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
        .select(['pn.e164 as e164', 'pn.status as status', 'r.sitecode as sitecode', 'r.carrier as carrier', 'r.kind as range_kind'])
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

    const notesFor = (key: string): HandoverNote[] => noteRows.filter((n) => n.section_key === key).map((n) => ({ sitecode: n.sitecode, body: n.body }));
    const hasNotes = (key: string) => notesFor(key).some((n) => n.body.trim() !== '');
    const blocks = (b: HandoverBlock[]): HandoverSectionContent => ({ kind: 'blocks', blocks: b });
    const plural = (n: number, one: string, many = `${one}s`) => `${n} x ${n === 1 ? one : many}`;

    // Phone numbers by how they came to the site (the range's type), then the allocation summary.
    const numberRows = phoneNumbers.map((p) => {
      const holder = holderOf.get(p.e164);
      const status = holder ? 'In use' : p.status === 'reserved' ? 'Reserved' : p.status === 'parked' ? 'Parked' : 'Spare';
      return { kind: p.range_kind as 'new' | 'port' | 'retain' | null, row: [p.e164, status, holder ?? '—', p.sitecode ?? '—', p.carrier ?? '—'] };
    });
    const numberColumns = ['Number', 'Status', 'Assigned to (in Teams)', 'Site', 'Carrier'];
    const numberGroup = (kind: 'new' | 'port' | 'retain' | null) => numberRows.filter((n) => n.kind === kind).map((n) => n.row);
    const count = (status: string) => numberRows.filter((n) => n.row[1] === status).length;
    const phoneBlocks: HandoverBlock[] = [];
    const groups: { kind: 'new' | 'port' | 'retain' | null; title: string; none: string | null; lead: (n: number) => string; caption: string }[] = [
      { kind: 'new', title: 'New Numbers', none: 'No new numbers were provided for the site.', lead: (n) => `A total of ${plural(n, 'new number')} were provided for this site:`, caption: "'New' Numbers Table" },
      { kind: 'port', title: 'Ported Numbers', none: null, lead: (n) => `A total of ${plural(n, 'number')} were ported in for this site:`, caption: "'Ported' Numbers Table" },
      { kind: 'retain', title: 'Re-pointed Numbers', none: 'No numbers were re-pointed for the site.', lead: (n) => `A total of ${plural(n, 'number')} were re-pointed for this site. The numbers re-pointed are as below:`, caption: "'Re-pointed' Numbers Table" },
      { kind: null, title: 'Other Numbers', none: null, lead: (n) => `${plural(n, 'number')} at this site are not in a number range:`, caption: "'Other' Numbers Table" },
    ];
    for (const g of groups) {
      const rows = numberGroup(g.kind);
      if (rows.length === 0 && g.none === null) continue;
      phoneBlocks.push({ kind: 'heading', title: g.title });
      if (rows.length === 0) phoneBlocks.push({ kind: 'text', text: g.none! });
      else phoneBlocks.push({ kind: 'text', text: g.lead(rows.length) }, { kind: 'table', columns: numberColumns, rows, caption: g.caption });
    }
    if (numberRows.length) {
      const allocation: string[][] = [
        ['Assigned to an object', String(count('In use')), 'For example, User, CAP, Auto Attendant.'],
        ['Spare', String(count('Spare')), 'Available for immediate use.'],
        ...(count('Reserved') ? [['Reserved', String(count('Reserved')), 'Held for a planned use.']] : []),
        ...(count('Parked') ? [['Parked', String(count('Parked')), 'Kept with the carrier; a contractual change is needed to bring the number back into service.']] : []),
      ];
      phoneBlocks.push({ kind: 'heading', title: 'Number Allocations' }, { kind: 'table', columns: ['Allocation', 'Quantity', 'Comments'], rows: allocation, caption: 'Number Allocations Table' });
    }

    // The policies used at the site, read from what its users and common area phones have in Teams.
    const used = (type: keyof typeof built.policiesUsed) => [...built.policiesUsed[type]].sort();
    const emergency = used('TeamsEmergencyCallingPolicy');
    const ecpRows = emergency.filter((n) => n !== 'Global').length
      ? await scoped.selectFrom('tenant_policies').select(['name', 'data']).where('policy_type', '=', 'TeamsEmergencyCallingPolicy').where('name', 'in', emergency).where('removed_at', 'is', null).execute()
      : [];
    const notifyOf = new Map(ecpRows.map((r) => [r.name, String(((r.data ?? {}) as Record<string, unknown>).NotificationGroup ?? '').trim()]));
    const anyIdentities = built.users.length + built.caps.length > 0;
    const policyTable = (title: string, names: string[], caption: string): HandoverBlock => ({ kind: 'table', columns: [title], rows: names.map((n) => [n]), caption, share: 0.6 });
    const teamsConfig: HandoverBlock[] = anyIdentities
      ? [
          { kind: 'heading', title: 'Voice Routing Policies' },
          { kind: 'text', text: 'The following voice routing policies were used for this site:' },
          policyTable('Voice Routing Policy', used('OnlineVoiceRoutingPolicy'), 'Voice Routing Policies Table'),
          { kind: 'heading', title: 'Dial Plan Policies' },
          { kind: 'text', text: used('TenantDialPlan').every((n) => n === 'Global') ? 'As there were no custom requirements, the Global dial plan was used.' : 'The following dial plans were used for this site:' },
          policyTable('Dial Plan Policies', used('TenantDialPlan'), 'Dial Plan Policies Table'),
          { kind: 'heading', title: 'Teams Calling Policies' },
          { kind: 'text', text: 'The following calling policies were used for users and common area phones:' },
          policyTable('Teams Calling Policies', used('TeamsCallingPolicy'), 'Teams Calling Policies Table'),
          { kind: 'heading', title: 'Emergency Calling Policies' },
          ...emergency.map(
            (n): HandoverBlock => ({
              kind: 'labels',
              title: 'Emergency Calling Policies',
              rows: [
                ['Emergency Calling Policy', n],
                ['Emergency notification recipients', notifyOf.get(n) || (n === 'Global' ? 'None set (Global policy)' : 'None set')],
              ],
              caption: 'Emergency Calling Policies Table',
            }),
          ),
        ]
      : [{ kind: 'text', text: 'No users or common area phones are live at these sites yet, so no Teams policies are in use.' }];
    // anything written by hand in Edit notes follows the figures
    const configNotes = noteSectionContent('teams_configuration', notesFor('teams_configuration'));
    if (configNotes.kind === 'paragraphs') teamsConfig.push(...configNotes.paragraphs.map((t): HandoverBlock => ({ kind: 'text', text: t })));

    const intro: HandoverSectionContent = hasNotes('introduction')
      ? noteSectionContent('introduction', notesFor('introduction'))
      : blocks([
          {
            kind: 'text',
            text: `The purpose of this document is to provide a standard formal hand-over pack to the ${t.name} and ${brandName} teams upon completion of the site migration. The provision of this documentation represents the clear demarcation and transition from ‘Project’ to ‘Day 2’ service, and provides all necessary information on:`,
          },
          {
            kind: 'bullets',
            items: [
              `The Service Support Model provided by ${brandName}`,
              'The Site Information including but not limited to:',
              '  Site name',
              '  Site address',
              '  Site code',
              '  Site contact/s',
              'The phone numbers provisioned for the site, and which are in use, spare or parked',
              'The MS Teams configuration information including but not limited to:',
              "  Provisioned 'Desktop Client End-Points / Users'",
              "  Provisioned 'Common Area Phones'",
              '  Auto attendants, call queues and their resource accounts',
              "The Site 'Paging' information, where paging was deployed",
            ],
          },
        ]);

    const byKey: Record<string, HandoverSectionContent> = {
      introduction: intro,

      site_information: blocks(
        sites.length === 0
          ? [{ kind: 'text', text: 'No site information was recorded.' }]
          : sites.map((x): HandoverBlock => {
              const ov = (x.overview ?? {}) as DiscoverySiteOverview;
              // Picked users by name; typed people as typed. Older overviews only have the one primary contact email.
              const contacts = ov.contacts?.siteContacts ?? (ov.primaryContactEmail ? [{ email: ov.primaryContactEmail }] : []);
              const people = contacts.map((c) => contactLabel(c, c.userId ? contactNames.get(c.userId) : null));
              const goLive = ov.targetGoLive && /^\d{4}-\d{2}-\d{2}$/.test(ov.targetGoLive) ? new Date(`${ov.targetGoLive}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : (ov.targetGoLive ?? '—');
              return {
                kind: 'labels',
                rows: [
                  ['Site Name', x.name ?? x.sitecode],
                  ['Site Address', x.address ?? '—'],
                  ['Site Code', x.sitecode],
                  ['Country / Region', [x.country, x.region].filter(Boolean).join(' / ') || '—'],
                  ['Site Contacts', people.join('\n') || '—'],
                  ['Target Go-Live', goLive],
                ],
                caption: sites.length > 1 ? `Site Information Table – ${x.sitecode}` : 'Site Information Table',
              };
            }),
      ),

      phone_numbers: blocks(phoneBlocks.length ? phoneBlocks : [{ kind: 'text', text: 'No phone numbers were recorded for the site.' }]),

      teams_users: blocks(
        built.users.length
          ? [
              { kind: 'text', text: 'The following users were enabled:' },
              { kind: 'table', columns: ['User Principal Name (UPN)', 'DID Number', 'Physical Phone', 'Voice Routing Policy'], rows: built.users, caption: "Teams 'User' Table" },
            ]
          : [{ kind: 'text', text: 'No Teams users were enabled.' }],
      ),

      common_area_phones: blocks(
        built.caps.length
          ? [
              { kind: 'text', text: `The following common area phones were deployed.${built.capModels.size ? ` The model used was ${[...built.capModels].sort().join(', ')}.` : ''}` },
              {
                kind: 'text',
                text: 'Please note the password is not stored in this document. If one of these devices is signed out, its password will need to be reset before the phone can be signed in again.',
              },
              { kind: 'table', columns: ['User Principal Name (UPN)', 'E.164 Number', 'Voice Routing Policy'], rows: built.caps, caption: 'Common Area Phones Table' },
            ]
          : [{ kind: 'text', text: 'No common area phones were deployed.' }],
      ),

      analogue_phones: blocks(
        analogue.length
          ? [
              { kind: 'text', text: 'The following analogue phones were deployed:' },
              { kind: 'table', columns: ['Number', 'Site', 'Note'], rows: analogue.map((a) => [a.e164, a.sitecode ?? '—', a.note ?? '—']), caption: 'Analogue Phones Table' },
            ]
          : [{ kind: 'text', text: 'No analogue phones were deployed.' }],
      ),

      auto_attendants: blocks(
        built.autoAttendants.length
          ? [
              { kind: 'text', text: 'The following auto attendants were deployed:' },
              { kind: 'table', columns: ['Name', 'Site', 'Language', 'Time zone', 'Resource accounts'], rows: built.autoAttendants, caption: 'Auto Attendants Information Table' },
              // the diagram of each auto attendant that is live (a diagram also shows the ones it hands calls to)
              ...((): HandoverBlock[] => {
                const live = new Set(built.autoAttendants.map((a) => a[0]!.toLowerCase()));
                const shown = diagrams.filter((d) => live.has(d.name.toLowerCase()));
                return shown.length
                  ? [{ kind: 'heading', title: 'Call Flow Diagram' }, ...shown.map((d): HandoverBlock => ({ kind: 'image', fileId: d.fileId, title: d.name, width: d.width, height: d.height }))]
                  : [];
              })(),
            ]
          : [{ kind: 'text', text: 'No auto attendants were deployed.' }],
      ),

      call_queues: blocks(
        built.callQueues.length
          ? [{ kind: 'text', text: 'The following call queues were created:' }, { kind: 'cards', cards: built.callQueues, caption: 'Call Queues Information Table' }]
          : [{ kind: 'text', text: 'No call queues were created.' }],
      ),

      resource_accounts: blocks(
        built.resourceAccounts.length
          ? [
              { kind: 'text', text: 'The following resource accounts were created:' },
              { kind: 'table', columns: ['UPN', 'Display name', 'Type', 'Site', 'Phone number', 'Voice routing policy'], rows: built.resourceAccounts, caption: 'Resource Accounts Information Table' },
            ]
          : [{ kind: 'text', text: 'No resource accounts were created.' }],
      ),

      voicemail_groups: blocks(
        voicemailGroups.length
          ? [
              { kind: 'text', text: 'The following Microsoft 365 groups take voicemail for the auto attendants and call queues:' },
              {
                kind: 'table',
                columns: ['Name', 'Email', 'Members', 'Owners'],
                rows: voicemailGroups.map((g) => [g.name, g.email ?? '—', String(jsonArrayLength(g.members)), String(jsonArrayLength(g.owners))]),
                caption: 'Voicemail Groups Table',
              },
            ]
          : [{ kind: 'text', text: 'No voicemail was deployed for the auto attendants.' }],
      ),

      teams_configuration: blocks(teamsConfig),

      network_data: blocks(
        network.length
          ? [
              {
                kind: 'table',
                columns: ['Site', 'Scope', 'Subnet', 'Mask', 'VLAN', 'Type', 'Location'],
                rows: network.map((n) => [n.sitecode ?? '—', n.scope, n.subnet, n.mask != null ? String(n.mask) : '—', n.vlan_id != null ? String(n.vlan_id) : '—', n.network_type ?? '—', n.location ?? '—']),
                caption: 'Network Data Table',
              },
            ]
          : [{ kind: 'text', text: 'No network data was recorded.' }],
      ),

      not_yet_live: built.notLive.length
        ? blocks([{ kind: 'table', columns: ['Item', 'Type', 'Site', 'What differs from the design'], rows: built.notLive, caption: "'Designed but Not Yet Live' Table" }])
        : blocks([{ kind: 'text', text: 'Everything designed in Design & Build for these sites is live in Teams.' }]),

      outstanding_actions: outstandingActionsContent(notesFor('outstanding_actions')),
    };

    // Service support model and paging are written by hand as notes (bullets and sub-headings drawn from the note's lines).
    for (const key of ['service_support_model', 'paging'] as const) byKey[key] = noteSectionContent(key, notesFor(key));

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
    const callQueues: [string, string][][] = [];
    const notLive: string[][] = [];
    // the policies the site's live users and common area phones have, by Teams policy type, and the phones' models
    const policiesUsed = { OnlineVoiceRoutingPolicy: new Set<string>(), TenantDialPlan: new Set<string>(), TeamsCallingPolicy: new Set<string>(), TeamsEmergencyCallingPolicy: new Set<string>() };
    const capModels = new Set<string>();
    const empty = { users, caps, resourceAccounts, autoAttendants, callQueues, notLive, policiesUsed, capModels };
    if (sites.length === 0) return empty;
    const siteIds = sites.map((x) => x.id);
    const codeOf = new Map(sites.map((x) => [x.id, x.sitecode]));

    const [userRows, capRows, raRows, aaRows, cqRows, liveNames, capDetails] = await Promise.all([
      s
        .selectFrom('build_users as b')
        .leftJoin('discovery_users as du', 'du.id', 'b.discovery_user_id')
        .select(['b.id as id', 'b.site_id as site_id', 'b.upn as upn', 'b.number_type as number_type', 'b.revoke_ev as revoke_ev', 'b.voicemail as voicemail', 'du.requires_handset as requires_handset', 'du.handset_model as handset_model'])
        .where('b.site_id', 'in', siteIds)
        .where('b.hidden', '=', false)
        .orderBy('b.upn')
        .execute(),
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
    const notePolicies = (live: LiveIdentityState) => {
      for (const type of Object.keys(policiesUsed) as (keyof typeof policiesUsed)[]) policiesUsed[type].add(policy(live, type));
    };
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
      notePolicies(live);
      // the template's four columns: UPN, number, whether the person has a desk phone, voice routing policy
      const phone = r.handset_model ? `Yes (${r.handset_model})` : r.requires_handset ? 'Yes' : 'No';
      users.push([r.upn, number(live), phone, policy(live, 'OnlineVoiceRoutingPolicy')]);
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
      notePolicies(live);
      const info = r.discovery_cap_id ? capInfo.get(r.discovery_cap_id) : undefined;
      if (info?.device_model) capModels.add(info.device_model);
      caps.push([r.upn, number(live), policy(live, 'OnlineVoiceRoutingPolicy')]);
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
      resourceAccounts.push([r.upn, r.display_name ?? '—', kind, codeOf.get(r.site_id) ?? '—', number(live), policy(live, 'OnlineVoiceRoutingPolicy')]);
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
      // Agent names, one per line - the customer needs to know who answers.
      const agents = Array.isArray(q.agents) ? (q.agents as string[]) : [];
      const agentText = agents.length ? `${agents.slice(0, 20).join('\n')}${agents.length > 20 ? `\nand ${agents.length - 20} more` : ''}` : 'None';
      // one label/value card per queue, printed two across
      callQueues.push([
        ['Name', q.name],
        ['Site', codeOf.get(q.site_id) ?? '—'],
        ['Routing Method', q.routing_method],
        ['Alert Time (Sec)', String(q.agent_alert_time)],
        ['Agents', agentText],
        ['Overflow', targetSummary(q.overflow as { action?: string; threshold?: number; target?: string | null } | null)],
        ['Timeout (Sec)', targetSummary(q.timeout as { action?: string; threshold?: number; target?: string | null } | null)],
        ['No Agents', targetSummary(q.no_agent_action as { action?: string; threshold?: number; target?: string | null } | null)],
      ]);
    }

    return { users, caps, resourceAccounts, autoAttendants, callQueues, notLive, policiesUsed, capModels };
  }
}
