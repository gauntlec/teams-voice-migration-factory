import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import { portStatusFor, siteContactTargets } from '@tvmf/shared';
import type {
  DiscoverySiteOverview,
  NumberPortItemRejectInput,
  NumberPortRequestItemsInput,
  PortCarrierDetailsInput,
  PortCompleteInput,
  PortDocumentItemSummary,
  PortDocumentTypeInput,
  SitePortDocumentTypeInput,
} from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { MailService } from '../../mail/mail.service';
import { assertSiteInScope } from '../data-collection/site-scope';
import { FilesService } from '../files/files.service';

type Actor = Pick<AuthedUser, 'id' | 'email'>;
const actorOf = (u: AuthedUser): Actor => ({ id: u.id, email: u.email });

/** A re-point range keeps its numbers where they are, so there is nothing to port. */
const RE_POINT_NO_PORTING = "A re-point range doesn't need porting.";

/**
 * "LOA Data Collection and Tracking" - PM/Engineer builds a per-number-range
 * document checklist (from a site-enabled subset of a global catalog),
 * submits it, and the customer uploads against it. See
 * packages/db/migrations/tenant/0021_number_port_requests.sql for the
 * three-tier model this implements.
 */
@Injectable()
export class NumberPortService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private s(t: TenantContext) {
    return tenantDb(this.db, t.schema);
  }

  /* ========================= global catalog ========================= */

  listDocumentTypes(t: TenantContext) {
    return this.s(t).selectFrom('port_document_types').selectAll().orderBy('ordinal').execute();
  }

  async createDocumentType(t: TenantContext, u: AuthedUser, input: PortDocumentTypeInput) {
    const row = await this.s(t)
      .insertInto('port_document_types')
      .values({
        key: input.key,
        label: input.label,
        ordinal: input.ordinal ?? 0,
        active: input.active ?? true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'number_port.document_type_created', {
      actor: actorOf(u),
      targetType: 'port_document_type',
      targetId: row.id,
      detail: { key: row.key },
    });
    return row;
  }

  async updateDocumentType(t: TenantContext, u: AuthedUser, id: string, patch: Partial<PortDocumentTypeInput>) {
    const set: Record<string, unknown> = {};
    for (const k of ['label', 'ordinal', 'active'] as const) if (k in patch) set[k] = patch[k];
    const row = await this.s(t)
      .updateTable('port_document_types')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('document type not found');
    await this.audit.tenant(t.schema, 'number_port.document_type_updated', {
      actor: actorOf(u),
      targetType: 'port_document_type',
      targetId: id,
      detail: patch,
    });
    return row;
  }

  /* ========================= site enablement ========================= */

  async listSiteDocumentTypes(t: TenantContext, siteId: string) {
    assertSiteInScope(t, siteId);
    const rows = await this.s(t)
      .selectFrom('port_document_types as dt')
      .leftJoin('site_port_document_types as s', (join) =>
        join.onRef('s.document_type_id', '=', 'dt.id').on('s.site_id', '=', siteId),
      )
      .select(['dt.id', 'dt.key', 'dt.label', 'dt.ordinal', sql<boolean>`coalesce(s.enabled, false)`.as('enabled')])
      .orderBy('dt.ordinal')
      .execute();
    return rows;
  }

  async setSiteDocumentType(t: TenantContext, u: AuthedUser, siteId: string, input: SitePortDocumentTypeInput) {
    assertSiteInScope(t, siteId);
    await this.s(t)
      .insertInto('site_port_document_types')
      .values({ site_id: siteId, document_type_id: input.document_type_id, enabled: input.enabled })
      .onConflict((oc) => oc.columns(['site_id', 'document_type_id']).doUpdateSet({ enabled: input.enabled }))
      .execute();
    await this.audit.tenant(t.schema, 'number_port.site_document_type_set', {
      actor: actorOf(u),
      targetType: 'discovery_site',
      targetId: siteId,
      detail: input,
    });
    return { ok: true };
  }

  /* ======================= carrier side of a port ======================= */

  /** A port-in range with its site, checked for scope. */
  private async portRange(t: TenantContext, rangeId: string) {
    const row = await this.s(t)
      .selectFrom('discovery_number_ranges as r')
      .innerJoin('discovery_sites as s', 's.sitecode', 'r.sitecode')
      .select([
        's.id as site_id', 's.name as site_name', 's.sitecode', 's.overview',
        'r.id', 'r.range_start', 'r.range_end', 'r.kind', 'r.carrier', 'r.new_carrier', 'r.previous_carrier', 'r.port_status',
        'r.port_order_ref', 'r.port_submitted_to_carrier_at', 'r.port_foc_date', 'r.port_completed_at',
      ])
      .where('r.id', '=', rangeId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('number range not found (or has no site)');
    assertSiteInScope(t, row.site_id);
    if (row.kind !== 'port') throw new BadRequestException('Only a port-in range moves to a new carrier.');
    return row;
  }

  /**
   * The document side changed (submitted, all in, one rejected): mirror it on the range, unless the port has moved on to the carrier
   * stages (with the carrier, scheduled, ported), which then stay as they are.
   */
  private async setDocumentsStatus(t: TenantContext, rangeId: string, docs: 'awaiting_documents' | 'complete') {
    const r = await this.s(t)
      .selectFrom('discovery_number_ranges')
      .select(['kind', 'port_submitted_to_carrier_at', 'port_foc_date', 'port_completed_at'])
      .where('id', '=', rangeId)
      .executeTakeFirst();
    const status = r ? portStatusFor({ ...r, port_status: docs }, docs) : docs;
    await this.s(t).updateTable('discovery_number_ranges').set({ port_status: status }).where('id', '=', rangeId).execute();
  }

  /** What the document side says, as the range mirrors it. */
  private async documentsStatus(t: TenantContext, rangeId: string): Promise<string | null> {
    const req = await this.s(t).selectFrom('number_port_requests').select('status').where('range_id', '=', rangeId).executeTakeFirst();
    return req?.status === 'complete' ? 'complete' : req?.status === 'awaiting_documents' ? 'awaiting_documents' : null;
  }

  /**
   * The carrier details of a port: the new carrier, the carrier's order reference, that it was submitted to the carrier, and the
   * scheduled port date. The range's port status follows (with the carrier / scheduled). Not changeable once the port is complete.
   */
  async updatePortDetails(t: TenantContext, u: AuthedUser, rangeId: string, input: PortCarrierDetailsInput) {
    const range = await this.portRange(t, rangeId);
    if (range.port_completed_at) throw new ConflictException('This port is already complete. Reopen it to change the details.');
    const set: Record<string, unknown> = {};
    if (input.newCarrier !== undefined) set.new_carrier = input.newCarrier?.trim() || null;
    if (input.portOrderRef !== undefined) set.port_order_ref = input.portOrderRef?.trim() || null;
    if (input.focDate !== undefined) set.port_foc_date = input.focDate || null;
    if (input.submittedToCarrier === true) set.port_submitted_to_carrier_at = range.port_submitted_to_carrier_at ?? new Date().toISOString();
    if (input.submittedToCarrier === false) {
      set.port_submitted_to_carrier_at = null;
      set.port_foc_date = null; // no scheduled date without the order
    }
    // A scheduled date means the order is with the carrier.
    if (set.port_foc_date && !range.port_submitted_to_carrier_at && set.port_submitted_to_carrier_at === undefined) set.port_submitted_to_carrier_at = new Date().toISOString();
    const merged = { ...range, ...set } as typeof range;
    if ((merged.port_submitted_to_carrier_at || merged.port_foc_date) && !merged.new_carrier) {
      throw new BadRequestException('Say which carrier the numbers are moving to first.');
    }
    set.port_status = portStatusFor(merged, await this.documentsStatus(t, rangeId));
    await this.s(t).updateTable('discovery_number_ranges').set(set).where('id', '=', rangeId).execute();
    await this.audit.tenant(t.schema, 'number_port.carrier_details_saved', {
      actor: actorOf(u),
      targetType: 'discovery_number_range',
      targetId: rangeId,
      detail: { ...input, status: set.port_status },
    });
    return { ok: true, port_status: set.port_status };
  }

  /**
   * The port has finished at the carrier: the range's carrier becomes the new carrier (the old one is kept as the previous carrier),
   * and the site's contacts are told. `completedOn` is the day it happened (default today, never in the future).
   */
  async completePort(t: TenantContext, u: AuthedUser, rangeId: string, input: PortCompleteInput) {
    const range = await this.portRange(t, rangeId);
    if (range.port_completed_at) throw new ConflictException('This port is already marked complete.');
    if (!range.new_carrier) throw new BadRequestException('Say which carrier the numbers moved to first.');
    const today = new Date().toISOString().slice(0, 10);
    const completedOn = input.completedOn ?? today;
    if (completedOn > today) throw new BadRequestException("A port can't be completed on a future date.");
    await this.s(t)
      .updateTable('discovery_number_ranges')
      .set({
        previous_carrier: range.carrier,
        carrier: range.new_carrier,
        port_completed_at: `${completedOn}T12:00:00Z`,
        port_completed_by: u.id,
        port_status: 'ported',
      })
      .where('id', '=', rangeId)
      .execute();
    await this.audit.tenant(t.schema, 'number_port.completed', {
      actor: actorOf(u),
      targetType: 'discovery_number_range',
      targetId: rangeId,
      detail: { from: range.carrier, to: range.new_carrier, completedOn },
    });

    const recipients = await this.resolveRecipients(t, range.site_id, (range.overview ?? {}) as DiscoverySiteOverview);
    const when = new Date(`${completedOn}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    for (const to of recipients) {
      await this.mail.enqueue({
        template: 'port_completed',
        to: { email: to.email, name: to.name },
        context: {
          recipientName: to.name,
          customerName: t.name,
          siteName: range.site_name ?? range.sitecode,
          sitecode: range.sitecode,
          rangeLabel: `${range.range_start} - ${range.range_end}`,
          fromCarrier: range.carrier,
          toCarrier: range.new_carrier,
          completedOn: when,
          portalUrl: this.portalUrl(range.site_id),
        },
        related: { type: 'discovery_number_range', id: rangeId },
        createdBy: u.id,
        tenantId: t.id,
      });
    }
    return { ok: true, carrier: range.new_carrier, recipients: recipients.length };
  }

  /** Undo a completion marked by mistake: the carrier goes back to what it was before. */
  async reopenPort(t: TenantContext, u: AuthedUser, rangeId: string) {
    const range = await this.portRange(t, rangeId);
    if (!range.port_completed_at) throw new ConflictException('This port is not marked complete.');
    const set = { carrier: range.previous_carrier, previous_carrier: null, port_completed_at: null, port_completed_by: null };
    const status = portStatusFor({ ...range, ...set }, await this.documentsStatus(t, rangeId));
    await this.s(t).updateTable('discovery_number_ranges').set({ ...set, port_status: status }).where('id', '=', rangeId).execute();
    await this.audit.tenant(t.schema, 'number_port.reopened', { actor: actorOf(u), targetType: 'discovery_number_range', targetId: rangeId, detail: { carrier: range.previous_carrier } });
    return { ok: true, port_status: status };
  }

  /* ============================ requests ============================ */

  /** Resolves a range's site (via its sitecode) and checks it's in the caller's scope. Throws if the range doesn't exist. */
  private async resolveRangeSite(t: TenantContext, rangeId: string) {
    const row = await this.s(t)
      .selectFrom('discovery_number_ranges as r')
      .innerJoin('discovery_sites as s', 's.sitecode', 'r.sitecode')
      .select(['s.id as site_id', 's.name as site_name', 's.sitecode', 's.overview', 'r.range_start', 'r.range_end', 'r.kind'])
      .where('r.id', '=', rangeId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('number range not found (or has no site)');
    assertSiteInScope(t, row.site_id);
    return row;
  }

  /** Resolves a request's range/site and checks scope. Throws if the request doesn't exist. */
  private async resolveRequestSite(t: TenantContext, requestId: string) {
    const row = await this.s(t)
      .selectFrom('number_port_requests as req')
      .innerJoin('discovery_number_ranges as r', 'r.id', 'req.range_id')
      .innerJoin('discovery_sites as s', 's.sitecode', 'r.sitecode')
      .select([
        'req.id as request_id',
        'req.range_id',
        'req.status',
        'req.submitted_by',
        's.id as site_id',
        's.name as site_name',
        's.sitecode',
        's.overview',
        'r.range_start',
        'r.range_end',
        'r.kind',
      ])
      .where('req.id', '=', requestId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('port request not found');
    assertSiteInScope(t, row.site_id);
    return row;
  }

  private async itemsWithType(t: TenantContext, requestId: string) {
    return this.s(t)
      .selectFrom('number_port_request_items as i')
      .innerJoin('port_document_types as dt', 'dt.id', 'i.document_type_id')
      .select([
        'i.id',
        'i.document_type_id',
        'i.note',
        'i.status',
        'i.reject_reason',
        'i.file_id',
        'i.updated_at',
        'dt.key as document_key',
        'dt.label as document_label',
      ])
      .where('i.request_id', '=', requestId)
      .orderBy('dt.ordinal')
      .execute();
  }

  /** Fetches the request for a number range, creating an empty draft on first access. */
  async getOrCreateRequest(t: TenantContext, rangeId: string) {
    const range = await this.resolveRangeSite(t, rangeId);
    if (range.kind === 'retain') throw new BadRequestException(RE_POINT_NO_PORTING);
    let request = await this.s(t)
      .selectFrom('number_port_requests')
      .selectAll()
      .where('range_id', '=', rangeId)
      .executeTakeFirst();
    if (!request) {
      request = await this.s(t)
        .insertInto('number_port_requests')
        .values({ range_id: rangeId, status: 'draft' })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const items = await this.itemsWithType(t, request.id);
    return { request, items };
  }

  /**
   * PM/Engineer builds the checklist - replaces the request's whole item set.
   * An item already `uploaded` that's dropped from the new set is deleted
   * along with it (the underlying file stays in the Files store, just
   * detached) - a deliberate simplification, not a bug.
   */
  async saveItems(t: TenantContext, u: AuthedUser, requestId: string, input: NumberPortRequestItemsInput) {
    const req = await this.resolveRequestSite(t, requestId);
    if (req.status === 'complete') {
      throw new ConflictException('This request is complete. Reopen it before changing the checklist.');
    }
    const existing = await this.s(t)
      .selectFrom('number_port_request_items')
      .select(['id', 'document_type_id'])
      .where('request_id', '=', requestId)
      .execute();
    const existingByType = new Map(existing.map((r) => [r.document_type_id, r.id]));
    const keepTypes = new Set(input.items.map((i) => i.document_type_id));

    for (const item of input.items) {
      const existingId = existingByType.get(item.document_type_id);
      if (existingId) {
        await this.s(t)
          .updateTable('number_port_request_items')
          .set({ note: item.note || null, updated_at: new Date().toISOString() })
          .where('id', '=', existingId)
          .execute();
      } else {
        await this.s(t)
          .insertInto('number_port_request_items')
          .values({ request_id: requestId, document_type_id: item.document_type_id, note: item.note || null })
          .execute();
      }
    }
    const toDelete = existing.filter((r) => !keepTypes.has(r.document_type_id)).map((r) => r.id);
    if (toDelete.length) {
      await this.s(t).deleteFrom('number_port_request_items').where('id', 'in', toDelete).execute();
    }

    await this.audit.tenant(t.schema, 'number_port.checklist_saved', {
      actor: actorOf(u),
      targetType: 'number_port_request',
      targetId: requestId,
      detail: { itemCount: input.items.length },
    });
    return this.itemsWithType(t, requestId);
  }

  /**
   * Who gets a number-port document email: every active CUSTOMER user scoped to this site (or whole-customer), plus the site's
   * Site contact(s) from the overview, whether picked from the users or typed. One email each.
   */
  private async resolveRecipients(t: TenantContext, siteId: string, overview: DiscoverySiteOverview) {
    const rows = await platformDb(this.db)
      .selectFrom('users as u')
      .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
      .select(['u.email', 'u.display_name'])
      .where('m.tenant_id', '=', t.id)
      .where('u.role', '=', 'CUSTOMER')
      .where('u.status', '=', 'active')
      .where(sql<boolean>`(m.site_ids = '{}' or ${siteId}::uuid = any(m.site_ids))`)
      .execute();
    const out = new Map<string, { email: string; name: string | null }>();
    for (const r of rows) out.set(r.email.toLowerCase(), { email: r.email, name: r.display_name as string | null });

    const targets = siteContactTargets(overview);
    if (targets.userIds.length) {
      const picked = await platformDb(this.db)
        .selectFrom('users')
        .select(['email', 'display_name'])
        .where('id', 'in', targets.userIds)
        .where('status', '=', 'active')
        .execute();
      for (const r of picked) if (!out.has(r.email.toLowerCase())) out.set(r.email.toLowerCase(), { email: r.email, name: r.display_name as string | null });
    }
    for (const c of targets.typed) if (!out.has(c.email.toLowerCase())) out.set(c.email.toLowerCase(), c);
    return [...out.values()];
  }

  private portalUrl(siteId: string): string {
    const origin = this.cfg.WEB_ORIGIN.replace(/\/+$/, '');
    return `${origin}/data-collection/sites/${siteId}/number-porting`;
  }

  private itemSummaries(items: Awaited<ReturnType<NumberPortService['itemsWithType']>>): PortDocumentItemSummary[] {
    return items.map((i) => ({
      label: i.document_label,
      note: i.note,
      status: i.status,
      rejectReason: i.reject_reason,
    }));
  }

  async submitRequest(t: TenantContext, u: AuthedUser, requestId: string) {
    const req = await this.resolveRequestSite(t, requestId);
    if (req.kind === 'retain') throw new BadRequestException(RE_POINT_NO_PORTING);
    if (req.status !== 'draft') {
      throw new ConflictException('This request has already been submitted.');
    }
    const items = await this.itemsWithType(t, requestId);
    if (items.length === 0) throw new BadRequestException('Add at least one document to the checklist before submitting.');

    await this.s(t)
      .updateTable('number_port_requests')
      .set({ status: 'awaiting_documents', submitted_by: u.id, submitted_at: new Date().toISOString() })
      .where('id', '=', requestId)
      .execute();
    await this.setDocumentsStatus(t, req.range_id, 'awaiting_documents');

    const overview = (req.overview ?? {}) as DiscoverySiteOverview;
    const recipients = await this.resolveRecipients(t, req.site_id, overview);
    const context = {
      customerName: t.name,
      siteName: req.site_name ?? req.sitecode,
      sitecode: req.sitecode,
      rangeLabel: `${req.range_start} - ${req.range_end}`,
      items: this.itemSummaries(items),
      portalUrl: this.portalUrl(req.site_id),
    };
    for (const to of recipients) {
      await this.mail.enqueue({
        template: 'port_documents_requested',
        to: { email: to.email, name: to.name },
        context,
        related: { type: 'number_port_request', id: requestId },
        createdBy: u.id,
        tenantId: t.id,
      });
    }

    await this.audit.tenant(t.schema, 'number_port.request_submitted', {
      actor: actorOf(u),
      targetType: 'number_port_request',
      targetId: requestId,
      detail: { itemCount: items.length, recipients: recipients.length },
    });
    return { ok: true, recipients: recipients.length };
  }

  /** Re-checks whether every non-waived item is uploaded; if so, completes the request and notifies whoever submitted it. */
  private async maybeComplete(t: TenantContext, req: Awaited<ReturnType<NumberPortService['resolveRequestSite']>>) {
    if (req.status !== 'awaiting_documents') return;
    const items = await this.itemsWithType(t, req.request_id);
    const outstanding = items.filter((i) => i.status !== 'uploaded' && i.status !== 'waived');
    if (outstanding.length > 0 || items.length === 0) return;

    await this.s(t)
      .updateTable('number_port_requests')
      .set({ status: 'complete' })
      .where('id', '=', req.request_id)
      .execute();
    await this.setDocumentsStatus(t, req.range_id, 'complete');

    if (!req.submitted_by) return;
    const submitter = await platformDb(this.db)
      .selectFrom('users')
      .select(['email', 'display_name'])
      .where('id', '=', req.submitted_by)
      .executeTakeFirst();
    if (!submitter) return;
    await this.mail.enqueue({
      template: 'port_documents_completed',
      to: { email: submitter.email, name: submitter.display_name },
      context: {
        recipientName: submitter.display_name,
        customerName: t.name,
        siteName: req.site_name ?? req.sitecode,
        sitecode: req.sitecode,
        rangeLabel: `${req.range_start} - ${req.range_end}`,
        runUrl: this.portalUrl(req.site_id),
      },
      related: { type: 'number_port_request', id: req.request_id },
      tenantId: t.id,
    });
  }

  async uploadItem(t: TenantContext, u: AuthedUser, requestId: string, itemId: string, file: Express.Multer.File) {
    const req = await this.resolveRequestSite(t, requestId);
    if (req.status === 'draft' || req.status === 'complete') {
      throw new ConflictException('This request is not currently accepting uploads.');
    }
    const item = await this.s(t)
      .selectFrom('number_port_request_items')
      .select(['id'])
      .where('id', '=', itemId)
      .where('request_id', '=', requestId)
      .executeTakeFirst();
    if (!item) throw new NotFoundException('checklist item not found');

    const stored = await this.files.store(t, {
      category: 'number_port_document',
      sourceType: 'number_port_request_item',
      sourceId: itemId,
      siteId: req.site_id,
      filename: file.originalname,
      contentType: file.mimetype,
      data: file.buffer,
      uploadedBy: u.id,
    });
    const updated = await this.s(t)
      .updateTable('number_port_request_items')
      .set({ file_id: stored.id, status: 'uploaded', reject_reason: null, updated_at: new Date().toISOString() })
      .where('id', '=', itemId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.tenant(t.schema, 'number_port.item_uploaded', {
      actor: actorOf(u),
      targetType: 'number_port_request_item',
      targetId: itemId,
      detail: { requestId, fileId: stored.id },
    });
    await this.maybeComplete(t, req);
    return updated;
  }

  async rejectItem(t: TenantContext, u: AuthedUser, requestId: string, itemId: string, input: NumberPortItemRejectInput) {
    const req = await this.resolveRequestSite(t, requestId);
    const item = await this.s(t)
      .updateTable('number_port_request_items')
      .set({ status: 'rejected', reject_reason: input.reason, updated_at: new Date().toISOString() })
      .where('id', '=', itemId)
      .where('request_id', '=', requestId)
      .returningAll()
      .executeTakeFirst();
    if (!item) throw new NotFoundException('checklist item not found');

    // A reject can only follow an earlier upload, which can only have
    // happened while the request was awaiting_documents - but if every other
    // item had already cleared and this was the last one, the request may
    // have just completed. Reopen it so the customer's re-upload is tracked.
    if (req.status === 'complete') {
      await this.s(t)
        .updateTable('number_port_requests')
        .set({ status: 'awaiting_documents' })
        .where('id', '=', requestId)
        .execute();
      await this.setDocumentsStatus(t, req.range_id, 'awaiting_documents');
    }

    await this.audit.tenant(t.schema, 'number_port.item_rejected', {
      actor: actorOf(u),
      targetType: 'number_port_request_item',
      targetId: itemId,
      detail: { requestId, reason: input.reason },
    });
    return item;
  }

  async waiveItem(t: TenantContext, u: AuthedUser, requestId: string, itemId: string, waived: boolean) {
    const req = await this.resolveRequestSite(t, requestId);
    const current = await this.s(t)
      .selectFrom('number_port_request_items')
      .select(['status'])
      .where('id', '=', itemId)
      .where('request_id', '=', requestId)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('checklist item not found');
    if (current.status === 'uploaded' && waived) {
      throw new ForbiddenException('This item already has an uploaded document - remove it from the checklist instead of waiving it.');
    }
    const item = await this.s(t)
      .updateTable('number_port_request_items')
      .set({ status: waived ? 'waived' : 'pending', updated_at: new Date().toISOString() })
      .where('id', '=', itemId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.tenant(t.schema, 'number_port.item_waived', {
      actor: actorOf(u),
      targetType: 'number_port_request_item',
      targetId: itemId,
      detail: { requestId, waived },
    });
    if (waived) await this.maybeComplete(t, req);
    return item;
  }
}
