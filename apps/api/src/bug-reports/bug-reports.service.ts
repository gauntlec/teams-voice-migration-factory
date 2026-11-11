import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb } from '@tvmf/db';
import { BUG_ATTACHMENT_MAX_BYTES, SR_ATTACHMENT_TYPES, type BugReportAttachment, type BugReportCreateInput, type BugReportUpdateInput, type BoardReplyCreateInput } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { AuditService, type AuditActor } from '../common/audit.service';
import { InjectDb, type Db } from '../db/db.module';
import { MailService } from '../mail/mail.service';
import { BoardReplies, BUG_REPLIES, type UploadedBoardFile } from '../common/board-replies';

/** Optional free-text columns — a cleared form field ('') is stored as NULL. */
const TEXT_COLS = ['affected_customer', 'environment', 'resolution_note'] as const;
/** What the person who reported a bug may change on it, while it is still New: its description, not where it is in triage. */
export const REPORTER_EDITABLE = ['title', 'area', 'severity', 'steps_to_reproduce', 'expected_behavior', 'actual_behavior', 'affected_customer', 'environment'] as const;
const nullifyBlank = (v: string | undefined | null) => (v == null || v === '' ? null : v);

@Injectable()
export class BugReportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.replies = new BoardReplies(db, audit, mail, () => this.boardUrl(), BUG_REPLIES);
  }

  /** The reply thread on each card (0045). */
  private readonly replies: BoardReplies;

  listReplies(id: string) {
    return this.replies.list(id);
  }

  addReply(id: string, input: BoardReplyCreateInput, file: UploadedBoardFile | undefined, actor: AuditActor) {
    return this.replies.add(id, input, file, actor);
  }

  removeReply(id: string, replyId: string, actor: AuditActor, canManage: boolean) {
    return this.replies.remove(id, replyId, actor, canManage);
  }

  private boardUrl(): string {
    return `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/bug-reports`;
  }

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
        sql<number>`(select count(*)::int from platform.bug_report_attachments a where a.bug_report_id = b.id and a.reply_id is null)`.as('attachment_count'),
        sql<number>`(select count(*)::int from platform.bug_report_replies r where r.bug_report_id = b.id)`.as('reply_count'),
        sql<string | null>`(select max(r.created_at) from platform.bug_report_replies r where r.bug_report_id = b.id)`.as('last_reply_at'),
        sql<string | null>`(select r.author_id from platform.bug_report_replies r where r.bug_report_id = b.id order by r.created_at desc, r.id desc limit 1)`.as('last_reply_by'),
      ])
      .orderBy('b.created_at', 'desc')
      .execute();
  }

  /** The files attached to a report, oldest first, without their bytes. */
  async attachments(id: string): Promise<BugReportAttachment[]> {
    await this.mustExist(id);
    const rows = await platformDb(this.db)
      .selectFrom('bug_report_attachments as a')
      .leftJoin('users as u', 'u.id', 'a.uploaded_by')
      .select(['a.id', 'a.filename', 'a.content_type', 'a.size', 'a.uploaded_by', 'a.created_at', 'u.display_name as uploaded_by_name'])
      .where('a.bug_report_id', '=', id)
      // files that came with a reply are listed under the reply
      .where('a.reply_id', 'is', null)
      .orderBy('a.created_at', 'asc')
      .execute();
    return rows.map((r) => ({ ...r, created_at: new Date(r.created_at as unknown as string).toISOString() }));
  }

  /**
   * Adds a file: a screenshot, a log, a written-up investigation. An administrator can attach to any report; the person who reported
   * the bug can attach to their own at any stage, since evidence often turns up after triage has started.
   */
  async attach(id: string, file: { originalname: string; mimetype: string; buffer: Buffer; size: number } | undefined, actor: AuditActor, canManage: boolean): Promise<BugReportAttachment> {
    const report = await this.mustExist(id);
    if (!canManage && (!actor.id || report.reported_by !== actor.id)) throw new ForbiddenException('Only the person who reported this bug, or an administrator, can attach files to it.');
    if (!file) throw new BadRequestException('Choose a file to attach.');
    if (file.size > BUG_ATTACHMENT_MAX_BYTES) throw new BadRequestException('That file is too large (10 MB at most).');
    if (!SR_ATTACHMENT_TYPES.test(file.mimetype)) throw new BadRequestException("That kind of file can't be attached. Use a picture, PDF, Word, Excel, PowerPoint, CSV or text file.");
    const filename = file.originalname.replace(/[/\\]/g, '_').trim().slice(0, 200) || 'file';
    const row = await platformDb(this.db)
      .insertInto('bug_report_attachments')
      .values({ bug_report_id: id, filename, content_type: file.mimetype, size: file.size, content: file.buffer, uploaded_by: actor.id ?? null })
      .returning(['id', 'filename', 'content_type', 'size', 'uploaded_by', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('bug.attachment_added', { actor, targetType: 'bug_report', targetId: id, detail: { filename, size: file.size } });
    return { ...row, uploaded_by_name: null, created_at: new Date(row.created_at as unknown as string).toISOString() };
  }

  /** One attached file with its bytes, if it belongs to this report. */
  async attachment(id: string, attachmentId: string) {
    const row = await platformDb(this.db).selectFrom('bug_report_attachments').selectAll().where('id', '=', attachmentId).where('bug_report_id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Attachment not found');
    return row;
  }

  /** Removes a file: an administrator, or whoever attached it. */
  async removeAttachment(id: string, attachmentId: string, actor: AuditActor, canManage: boolean) {
    const row = await platformDb(this.db).selectFrom('bug_report_attachments').select(['id', 'filename', 'uploaded_by']).where('id', '=', attachmentId).where('bug_report_id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Attachment not found');
    if (!canManage && (!actor.id || row.uploaded_by !== actor.id)) throw new ForbiddenException('Only whoever attached this file, or an administrator, can remove it.');
    await platformDb(this.db).deleteFrom('bug_report_attachments').where('id', '=', attachmentId).execute();
    await this.audit.platform('bug.attachment_removed', { actor, targetType: 'bug_report', targetId: id, detail: { filename: row.filename } });
    return { ok: true };
  }

  private async mustExist(id: string) {
    const row = await platformDb(this.db).selectFrom('bug_reports').select(['id', 'reported_by']).where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Bug report not found');
    return row;
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

  /**
   * `canManage` (bug:manage, Super Admin) may change anything. Anyone else may change only the description of a bug they reported
   * themselves, and only while it is New - once an administrator has started triage the report is theirs to keep in step (bug
   * report "Bug Report Edit").
   */
  async update(id: string, input: BugReportUpdateInput, actor: AuditActor, canManage = true) {
    const existing = await platformDb(this.db)
      .selectFrom('bug_reports')
      .select(['id', 'status', 'reported_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundException('Bug report not found');
    if (!canManage) {
      if (!actor.id || existing.reported_by !== actor.id) throw new ForbiddenException('Only the person who reported this bug, or an administrator, can edit it.');
      if (existing.status !== 'new') throw new ForbiddenException('This bug is already being worked on, so only an administrator can change it now. Add what you know in a new report, or ask an administrator.');
      const other = Object.keys(input).filter((k) => input[k as keyof BugReportUpdateInput] !== undefined && !(REPORTER_EDITABLE as readonly string[]).includes(k));
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

    // Notify the reporter on a real status move (the "action taken" moment) -
    // not on every edit, and not when they moved their own card.
    if (statusChanged && existing.reported_by && existing.reported_by !== actor.id) {
      const reporter = await platformDb(this.db)
        .selectFrom('users')
        .select(['email', 'display_name'])
        .where('id', '=', existing.reported_by)
        .executeTakeFirst();
      if (reporter) {
        await this.mail.enqueue({
          template: 'bug_report_status_changed',
          to: { email: reporter.email, name: reporter.display_name },
          context: {
            title: row.title,
            area: row.area,
            fromStatus: existing.status,
            toStatus: row.status,
            resolutionNote: row.resolution_note,
            runUrl: this.boardUrl(),
          },
          related: { type: 'bug_report', id },
          createdBy: actor.id ?? null,
        });
      }
    }
    return row;
  }

  async remove(id: string, actor: AuditActor, canManage = true) {
    if (!canManage) {
      const existing = await platformDb(this.db).selectFrom('bug_reports').select(['status', 'reported_by']).where('id', '=', id).executeTakeFirst();
      if (!existing) throw new NotFoundException('Bug report not found');
      if (!actor.id || existing.reported_by !== actor.id) throw new ForbiddenException('Only the person who reported this bug, or an administrator, can delete it.');
      if (existing.status !== 'new') throw new ForbiddenException('This bug is already being worked on, so only an administrator can delete it now.');
    }
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
