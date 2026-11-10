import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb } from '@tvmf/db';
import { FEATURE_ATTACHMENT_MAX_BYTES, SR_ATTACHMENT_TYPES, type FeatureRequestAttachment, type FeatureRequestCreateInput, type FeatureRequestUpdateInput } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { AuditService, type AuditActor } from '../common/audit.service';
import { InjectDb, type Db } from '../db/db.module';
import { MailService } from '../mail/mail.service';

/** Optional free-text columns — a cleared form field ('') is stored as NULL. */
const TEXT_COLS = ['current_behavior', 'examples', 'acceptance', 'constraints', 'decision_note'] as const;
const nullifyBlank = (v: string | undefined | null) => (v == null || v === '' ? null : v);
/** What the person who asked for a feature may still change while it is New: the request itself, not its place on the board or the decision. */
export const REQUESTER_EDITABLE = ['title', 'area', 'priority', 'problem', 'proposal', 'current_behavior', 'examples', 'acceptance', 'constraints', 'affected_roles'] as const;

@Injectable()
export class FeatureRequestsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private boardUrl(): string {
    return `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/feature-requests`;
  }

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
        sql<number>`(select count(*)::int from platform.feature_request_attachments a where a.feature_request_id = f.id)`.as('attachment_count'),
      ])
      .orderBy('f.created_at', 'desc')
      .execute();
  }

  /** The files attached to a request, oldest first, without their bytes. */
  async attachments(id: string): Promise<FeatureRequestAttachment[]> {
    await this.mustExist(id);
    const rows = await platformDb(this.db)
      .selectFrom('feature_request_attachments as a')
      .leftJoin('users as u', 'u.id', 'a.uploaded_by')
      .select(['a.id', 'a.filename', 'a.content_type', 'a.size', 'a.uploaded_by', 'a.created_at', 'u.display_name as uploaded_by_name'])
      .where('a.feature_request_id', '=', id)
      .orderBy('a.created_at', 'asc')
      .execute();
    return rows.map((r) => ({ ...r, created_at: new Date(r.created_at as unknown as string).toISOString() }));
  }

  /**
   * Adds a file: a mock-up, a spreadsheet, an example document. An administrator can attach to any request; the person who asked
   * for it can attach to their own at any stage, as with bug reports.
   */
  async attach(id: string, file: { originalname: string; mimetype: string; buffer: Buffer; size: number } | undefined, actor: AuditActor, canManage: boolean): Promise<FeatureRequestAttachment> {
    const request = await this.mustExist(id);
    if (!canManage && (!actor.id || request.submitted_by !== actor.id)) throw new ForbiddenException('Only the person who asked for this, or an administrator, can attach files to it.');
    if (!file) throw new BadRequestException('Choose a file to attach.');
    if (file.size > FEATURE_ATTACHMENT_MAX_BYTES) throw new BadRequestException('That file is too large (10 MB at most).');
    if (!SR_ATTACHMENT_TYPES.test(file.mimetype)) throw new BadRequestException("That kind of file can't be attached. Use a picture, PDF, Word, Excel, PowerPoint, CSV or text file.");
    const filename = file.originalname.replace(/[/\\]/g, '_').trim().slice(0, 200) || 'file';
    const row = await platformDb(this.db)
      .insertInto('feature_request_attachments')
      .values({ feature_request_id: id, filename, content_type: file.mimetype, size: file.size, content: file.buffer, uploaded_by: actor.id ?? null })
      .returning(['id', 'filename', 'content_type', 'size', 'uploaded_by', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('feature.attachment_added', { actor, targetType: 'feature_request', targetId: id, detail: { filename, size: file.size } });
    return { ...row, uploaded_by_name: null, created_at: new Date(row.created_at as unknown as string).toISOString() };
  }

  /** One attached file with its bytes, if it belongs to this request. */
  async attachment(id: string, attachmentId: string) {
    const row = await platformDb(this.db).selectFrom('feature_request_attachments').selectAll().where('id', '=', attachmentId).where('feature_request_id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Attachment not found');
    return row;
  }

  /** Removes a file: an administrator, or whoever attached it. */
  async removeAttachment(id: string, attachmentId: string, actor: AuditActor, canManage: boolean) {
    const row = await platformDb(this.db).selectFrom('feature_request_attachments').select(['id', 'filename', 'uploaded_by']).where('id', '=', attachmentId).where('feature_request_id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Attachment not found');
    if (!canManage && (!actor.id || row.uploaded_by !== actor.id)) throw new ForbiddenException('Only whoever attached this file, or an administrator, can remove it.');
    await platformDb(this.db).deleteFrom('feature_request_attachments').where('id', '=', attachmentId).execute();
    await this.audit.platform('feature.attachment_removed', { actor, targetType: 'feature_request', targetId: id, detail: { filename: row.filename } });
    return { ok: true };
  }

  private async mustExist(id: string) {
    const row = await platformDb(this.db).selectFrom('feature_requests').select(['id', 'submitted_by']).where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Feature request not found');
    return row;
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

  async update(id: string, input: FeatureRequestUpdateInput, actor: AuditActor, canManage = true) {
    const existing = await platformDb(this.db)
      .selectFrom('feature_requests')
      .select(['id', 'status', 'submitted_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Feature request not found');
    if (!canManage) {
      ownNewRequest(existing, actor, 'edit');
      const other = Object.keys(input).filter((k) => input[k as keyof FeatureRequestUpdateInput] !== undefined && !(REQUESTER_EDITABLE as readonly string[]).includes(k));
      if (other.length) throw new ForbiddenException(`Only an administrator can change ${other.join(', ')}.`);
    }

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

    // Notify the submitter on a real status move (the "action taken" moment) -
    // not on every edit, and not when they moved their own card.
    if (statusChanged && existing.submitted_by && existing.submitted_by !== actor.id) {
      const submitter = await platformDb(this.db)
        .selectFrom('users')
        .select(['email', 'display_name'])
        .where('id', '=', existing.submitted_by)
        .executeTakeFirst();
      if (submitter) {
        await this.mail.enqueue({
          template: 'feature_request_status_changed',
          to: { email: submitter.email, name: submitter.display_name },
          context: {
            title: row.title,
            area: row.area,
            fromStatus: existing.status,
            toStatus: row.status,
            decisionNote: row.decision_note,
            runUrl: this.boardUrl(),
          },
          related: { type: 'feature_request', id },
          createdBy: actor.id ?? null,
        });
      }
    }
    return row;
  }

  async remove(id: string, actor: AuditActor, canManage = true) {
    if (!canManage) {
      const existing = await platformDb(this.db).selectFrom('feature_requests').select(['status', 'submitted_by']).where('id', '=', id).executeTakeFirst();
      if (!existing) throw new NotFoundException('Feature request not found');
      ownNewRequest(existing, actor, 'delete');
    }
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

/** The person who asked for a feature may change or withdraw it until an administrator has picked it up; after that it is the board's. */
function ownNewRequest(existing: { status: string; submitted_by: string | null }, actor: AuditActor, what: 'edit' | 'delete') {
  if (!actor.id || existing.submitted_by !== actor.id) throw new ForbiddenException(`Only the person who asked for this feature, or an administrator, can ${what} it.`);
  if (existing.status !== 'new') throw new ForbiddenException(`This request has already been picked up, so only an administrator can ${what} it now.`);
}
