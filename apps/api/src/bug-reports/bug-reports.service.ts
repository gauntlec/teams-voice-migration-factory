import { Injectable, NotFoundException } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import type { BugReportCreateInput, BugReportUpdateInput } from '@tvmf/shared';
import { AuditService, type AuditActor } from '../common/audit.service';
import { InjectDb, type Db } from '../db/db.module';

/** Optional free-text columns — a cleared form field ('') is stored as NULL. */
const TEXT_COLS = ['affected_customer', 'environment', 'resolution_note'] as const;
const nullifyBlank = (v: string | undefined | null) => (v == null || v === '' ? null : v);

@Injectable()
export class BugReportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Every report, newest first, with the reporter's display name for the card. */
  list() {
    return platformDb(this.db)
      .selectFrom('bug_reports as b')
      .leftJoin('users as u', 'u.id', 'b.reported_by')
      .select([
        'b.id',
        'b.title',
        'b.area',
        'b.status',
        'b.severity',
        'b.steps_to_reproduce',
        'b.expected_behavior',
        'b.actual_behavior',
        'b.affected_customer',
        'b.environment',
        'b.resolution_note',
        'b.reported_by',
        'b.created_at',
        'b.updated_at',
        'b.status_changed_at',
        'u.display_name as reported_by_name',
      ])
      .orderBy('b.created_at', 'desc')
      .execute();
  }

  async create(input: BugReportCreateInput, actor: AuditActor) {
    const row = await platformDb(this.db)
      .insertInto('bug_reports')
      .values({
        title: input.title,
        area: input.area,
        severity: input.severity ?? 'medium',
        steps_to_reproduce: input.steps_to_reproduce,
        expected_behavior: input.expected_behavior,
        actual_behavior: input.actual_behavior,
        affected_customer: nullifyBlank(input.affected_customer),
        environment: nullifyBlank(input.environment),
        reported_by: actor.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.platform('bug.created', {
      actor,
      targetType: 'bug_report',
      targetId: row.id,
      detail: { title: row.title, area: row.area, severity: row.severity },
    });
    return row;
  }

  async update(id: string, input: BugReportUpdateInput, actor: AuditActor) {
    const existing = await platformDb(this.db)
      .selectFrom('bug_reports')
      .select(['id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Bug report not found');

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
      .updateTable('bug_reports')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.platform(statusChanged ? 'bug.status_changed' : 'bug.updated', {
      actor,
      targetType: 'bug_report',
      targetId: id,
      detail: statusChanged
        ? { from: existing.status, to: input.status }
        : { fields: Object.keys(input) },
    });
    return row;
  }

  async remove(id: string, actor: AuditActor) {
    const row = await platformDb(this.db)
      .deleteFrom('bug_reports')
      .where('id', '=', id)
      .returning(['id', 'title'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Bug report not found');
    await this.audit.platform('bug.deleted', {
      actor,
      targetType: 'bug_report',
      targetId: id,
      detail: { title: row.title },
    });
    return { ok: true };
  }
}
