import { Injectable, NotFoundException } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import type { FeatureRequestCreateInput, FeatureRequestUpdateInput } from '@tvmf/shared';
import { AuditService, type AuditActor } from '../common/audit.service';
import { InjectDb, type Db } from '../db/db.module';

/** Optional free-text columns — a cleared form field ('') is stored as NULL. */
const TEXT_COLS = ['current_behavior', 'examples', 'acceptance', 'constraints', 'decision_note'] as const;
const nullifyBlank = (v: string | undefined | null) => (v == null || v === '' ? null : v);

@Injectable()
export class FeatureRequestsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Every request, newest first, with the submitter's display name for the card. */
  list() {
    return platformDb(this.db)
      .selectFrom('feature_requests as f')
      .leftJoin('users as u', 'u.id', 'f.submitted_by')
      .select([
        'f.id',
        'f.title',
        'f.area',
        'f.status',
        'f.priority',
        'f.problem',
        'f.proposal',
        'f.current_behavior',
        'f.examples',
        'f.acceptance',
        'f.constraints',
        'f.affected_roles',
        'f.decision_note',
        'f.submitted_by',
        'f.created_at',
        'f.updated_at',
        'f.status_changed_at',
        'u.display_name as submitted_by_name',
      ])
      .orderBy('f.created_at', 'desc')
      .execute();
  }

  async create(input: FeatureRequestCreateInput, actor: AuditActor) {
    const row = await platformDb(this.db)
      .insertInto('feature_requests')
      .values({
        title: input.title,
        area: input.area,
        priority: input.priority ?? 'medium',
        problem: input.problem,
        proposal: input.proposal,
        current_behavior: nullifyBlank(input.current_behavior),
        examples: nullifyBlank(input.examples),
        acceptance: nullifyBlank(input.acceptance),
        constraints: nullifyBlank(input.constraints),
        affected_roles: input.affected_roles ?? [],
        submitted_by: actor.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.platform('feature.created', {
      actor,
      targetType: 'feature_request',
      targetId: row.id,
      detail: { title: row.title, area: row.area, priority: row.priority },
    });
    return row;
  }

  async update(id: string, input: FeatureRequestUpdateInput, actor: AuditActor) {
    const existing = await platformDb(this.db)
      .selectFrom('feature_requests')
      .select(['id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Feature request not found');

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      patch[k] = (TEXT_COLS as readonly string[]).includes(k) ? nullifyBlank(v as string) : v;
    }
    const statusChanged = input.status != null && input.status !== existing.status;
    if (statusChanged) {
      patch.status_changed_at = new Date().toISOString();
      patch.status_changed_by = actor.id ?? null;
    }

    const row = await platformDb(this.db)
      .updateTable('feature_requests')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.platform(statusChanged ? 'feature.status_changed' : 'feature.updated', {
      actor,
      targetType: 'feature_request',
      targetId: id,
      detail: statusChanged
        ? { from: existing.status, to: input.status }
        : { fields: Object.keys(input) },
    });
    return row;
  }

  async remove(id: string, actor: AuditActor) {
    const row = await platformDb(this.db)
      .deleteFrom('feature_requests')
      .where('id', '=', id)
      .returning(['id', 'title'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Feature request not found');
    await this.audit.platform('feature.deleted', {
      actor,
      targetType: 'feature_request',
      targetId: id,
      detail: { title: row.title },
    });
    return { ok: true };
  }
}
