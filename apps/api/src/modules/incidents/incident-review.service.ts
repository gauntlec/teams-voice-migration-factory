import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { incReference, type IncidentReviewInput } from '@tvmf/shared';
import { platformDb } from '@tvmf/db';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';
import { IncidentNotifier } from './incident-notifier';

/**
 * Post-incident review: what happened, why, what worked and what didn't, and the follow-up
 * actions. The timeline is built from the incident's own public events when it is shown, so
 * it can't drift from the record. The team writes it as a draft and shares it; customers see
 * it (and are emailed) once it is shared. See docs/INCIDENT-MANAGEMENT.md.
 */
@Injectable()
export class IncidentReviewService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: IncidentNotifier,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('incident not found');
    if (isSiteScoped(t)) assertSiteInScope(t, row.site_id);
    return row;
  }

  /** The review with the incident's public timeline. A draft is for the team only. */
  async get(t: TenantContext, id: string, canManage: boolean) {
    this.assertEnabled(t);
    const inc = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const review = await s.selectFrom('incident_reviews').selectAll().where('incident_id', '=', id).executeTakeFirst();
    if (!review || (!canManage && review.status !== 'shared')) {
      if (canManage) return { review: null, timeline: await this.timeline(t, id), incident: { reference: incReference(inc.number), title: inc.title, status: inc.status, major: inc.major } };
      throw new NotFoundException('There is no review of this incident yet.');
    }
    const ids = [review.created_by, review.updated_by, review.shared_by].filter((v): v is string => !!v);
    const users = ids.length ? await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', ids).execute() : [];
    const name = (u: string | null) => users.find((x) => x.id === u)?.display_name ?? null;
    return {
      review: { ...review, created_by_name: name(review.created_by), shared_by_name: name(review.shared_by) },
      timeline: await this.timeline(t, id),
      incident: { reference: incReference(inc.number), title: inc.title, status: inc.status, major: inc.major },
    };
  }

  /** What the customer saw happen, in order - the incident's public events. */
  private async timeline(t: TenantContext, id: string) {
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom('incident_events')
      .select(['kind', 'from_status', 'to_status', 'body', 'meta', 'created_at'])
      .where('incident_id', '=', id)
      .where('internal', '=', false)
      .where('kind', 'in', ['created', 'status_changed', 'major_declared', 'major_update', 'major_ended', 'priority_changed', 'comment'])
      .orderBy('created_at')
      .execute();
    return rows.map((e) => ({ kind: e.kind, at: e.created_at, text: e.body ?? '', to_status: e.to_status, move: (e.meta as { kind?: string } | null)?.kind ?? null }));
  }

  async put(t: TenantContext, user: AuthedUser, id: string, input: IncidentReviewInput) {
    this.assertEnabled(t);
    const inc = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const now = new Date().toISOString();
    const values = { summary: input.summary, cause: input.cause, went_well: input.wentWell, went_badly: input.wentBadly, actions: JSON.stringify(input.actions), updated_by: user.id, updated_at: now };
    const row = await s
      .insertInto('incident_reviews')
      .values({ incident_id: id, created_by: user.id, ...values })
      .onConflict((oc) => oc.column('incident_id').doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'incident.review_saved', { actor: { id: user.id, email: user.email }, targetType: 'incident', targetId: id, detail: { reference: incReference(inc.number), status: row.status } });
    return row;
  }

  /** Share the review with the customer: it becomes visible and the customer side is emailed. */
  async share(t: TenantContext, user: AuthedUser, id: string) {
    this.assertEnabled(t);
    const inc = await this.load(t, id);
    const s = tenantDb(this.db, t.schema);
    const review = await s.selectFrom('incident_reviews').selectAll().where('incident_id', '=', id).executeTakeFirst();
    if (!review) throw new BadRequestException('Write the review first.');
    if (review.status === 'shared') throw new BadRequestException('This review has already been shared.');
    if (!review.summary.trim() || !review.cause.trim()) throw new BadRequestException('Say what happened and why before sharing it.');
    const now = new Date().toISOString();
    const shared = await s.updateTable('incident_reviews').set({ status: 'shared', shared_at: now, shared_by: user.id, updated_at: now }).where('incident_id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
    if (!shared) throw new BadRequestException('This review has already been shared.');
    await s.insertInto('incident_events').values({ incident_id: id, kind: 'review_shared', body: 'Shared the post-incident review.', author_id: user.id }).execute();
    await this.audit.tenant(t.schema, 'incident.review_shared', { actor: { id: user.id, email: user.email }, targetType: 'incident', targetId: id, detail: { reference: incReference(inc.number) } });
    await this.notify.reviewShared(t, user, inc, { summary: review.summary, cause: review.cause, actions: review.actions });
    return shared;
  }
}
