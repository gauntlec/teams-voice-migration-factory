import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import type {
  DiscoverySiteOverview,
  NumberPortItemRejectInput,
  NumberPortRequestItemsInput,
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
      .where('dt.active', '=', true)
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

  /* ============================ requests ============================ */

  /** Resolves a range's site (via its sitecode) and checks it's in the caller's scope. Throws if the range doesn't exist. */
  private async resolveRangeSite(t: TenantContext, rangeId: string) {
    const row = await this.s(t)
      .selectFrom('discovery_number_ranges as r')
      .innerJoin('discovery_sites as s', 's.sitecode', 'r.sitecode')
      .select(['s.id as site_id', 's.name as site_name', 's.sitecode', 's.overview', 'r.range_start', 'r.range_end'])
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
    await this.resolveRangeSite(t, rangeId);
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

  /** Every active CUSTOMER user scoped to this site (or whole-customer), falling back to the site overview's primary contact. */
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
    if (rows.length) return rows.map((r) => ({ email: r.email, name: r.display_name as string | null }));
    return overview.primaryContactEmail ? [{ email: overview.primaryContactEmail, name: null }] : [];
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
    await this.s(t)
      .updateTable('discovery_number_ranges')
      .set({ port_status: 'awaiting_documents' })
      .where('id', '=', req.range_id)
      .execute();

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
    await this.s(t)
      .updateTable('discovery_number_ranges')
      .set({ port_status: 'complete' })
      .where('id', '=', req.range_id)
      .execute();

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
      await this.s(t)
        .updateTable('discovery_number_ranges')
        .set({ port_status: 'awaiting_documents' })
        .where('id', '=', req.range_id)
        .execute();
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
