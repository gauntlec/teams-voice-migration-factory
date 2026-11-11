import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { platformDb } from '@tvmf/db';
import {
  BUG_ATTACHMENT_MAX_BYTES,
  SR_ATTACHMENT_TYPES,
  can,
  type BoardReply,
  type BoardReplyContext,
  type BoardReplyCreateInput,
  type Permission,
  type Role,
} from '@tvmf/shared';
import type { AuditActor, AuditService } from './audit.service';
import type { Db } from '../db/db.module';
import type { MailService } from '../mail/mail.service';

/** An uploaded file as multer hands it over. */
export type UploadedBoardFile = { originalname: string; mimetype: string; buffer: Buffer; size: number };

/** Which board: its tables and words. The two boards are the same shape with different names (migrations 0042, 0043, 0045). */
export interface BoardReplyConfig {
  board: BoardReplyContext['board'];
  cards: 'bug_reports' | 'feature_requests';
  replies: 'bug_report_replies' | 'feature_request_replies';
  attachments: 'bug_report_attachments' | 'feature_request_attachments';
  fk: 'bug_report_id' | 'feature_request_id';
  /** The column naming who raised the card. */
  owner: 'reported_by' | 'submitted_by';
  /** Who can see the board, so who may be emailed about it. */
  readPermission: Extract<Permission, 'bug:read' | 'feature:read'>;
  auditPrefix: 'bug' | 'feature';
  targetType: 'bug_report' | 'feature_request';
  notFound: string;
}

export const BUG_REPLIES: BoardReplyConfig = {
  board: 'bug',
  cards: 'bug_reports',
  replies: 'bug_report_replies',
  attachments: 'bug_report_attachments',
  fk: 'bug_report_id',
  owner: 'reported_by',
  readPermission: 'bug:read',
  auditPrefix: 'bug',
  targetType: 'bug_report',
  notFound: 'Bug report not found',
};

export const FEATURE_REPLIES: BoardReplyConfig = {
  board: 'feature',
  cards: 'feature_requests',
  replies: 'feature_request_replies',
  attachments: 'feature_request_attachments',
  fk: 'feature_request_id',
  owner: 'submitted_by',
  readPermission: 'feature:read',
  auditPrefix: 'feature',
  targetType: 'feature_request',
  notFound: 'Feature request not found',
};

/**
 * Checks a file for a card or a reply: 10 MB at most, and only the kinds the boards already take. Returns the name it is stored under.
 */
export function checkBoardFile(file: UploadedBoardFile): string {
  if (file.size > BUG_ATTACHMENT_MAX_BYTES) throw new BadRequestException('That file is too large (10 MB at most).');
  if (!SR_ATTACHMENT_TYPES.test(file.mimetype)) throw new BadRequestException("That kind of file can't be attached. Use a picture, PDF, Word, Excel, PowerPoint, CSV or text file.");
  return file.originalname.replace(/[/\\]/g, '_').trim().slice(0, 200) || 'file';
}

/**
 * The reply thread on a Bug reports or Feature requests card (0045). Anyone who can see the board may reply on any card, with one optional
 * file; the author or an administrator may delete a reply (its file goes with it). The card's owner, everyone else who has replied, and the
 * administrator who last moved the card are emailed - not the author, and only while they can still see the board.
 */
export class BoardReplies {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly boardUrl: () => string,
    private readonly c: BoardReplyConfig,
  ) {}

  /** The two boards share one code path over tables with different names, which Kysely's typed builder cannot express. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get q(): Kysely<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return platformDb(this.db) as unknown as Kysely<any>;
  }

  private async card(id: string): Promise<{ id: string; title: string; area: string; owner: string | null; status_changed_by: string | null }> {
    const row = await this.q
      .selectFrom(this.c.cards)
      .select(['id', 'title', 'area', `${this.c.owner} as owner`, 'status_changed_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(this.c.notFound);
    return row;
  }

  /** Every reply on a card, oldest first, with its author's name and its files (without their bytes). */
  async list(cardId: string): Promise<BoardReply[]> {
    await this.card(cardId);
    const rows: { id: string; body: string; author_id: string | null; author_name: string | null; created_at: string | Date }[] = await this.q
      .selectFrom(`${this.c.replies} as r`)
      .leftJoin('users as u', 'u.id', 'r.author_id')
      .select(['r.id', 'r.body', 'r.author_id', 'r.created_at', 'u.display_name as author_name'])
      .where(`r.${this.c.fk}`, '=', cardId)
      .orderBy('r.created_at', 'asc')
      .orderBy('r.id', 'asc')
      .execute();
    const files: { id: string; reply_id: string; filename: string; content_type: string; size: number }[] = rows.length
      ? await this.q
          .selectFrom(this.c.attachments)
          .select(['id', 'reply_id', 'filename', 'content_type', 'size'])
          .where(this.c.fk, '=', cardId)
          .where('reply_id', 'is not', null)
          .orderBy('created_at', 'asc')
          .execute()
      : [];
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      author_id: r.author_id,
      author_name: r.author_name,
      created_at: new Date(r.created_at).toISOString(),
      attachments: files.filter((f) => f.reply_id === r.id).map(({ id, filename, content_type, size }) => ({ id, filename, content_type, size })),
    }));
  }

  /** Adds a reply, with its file if one came, then tells the people following the card. */
  async add(cardId: string, input: BoardReplyCreateInput, file: UploadedBoardFile | undefined, actor: AuditActor): Promise<BoardReply> {
    const card = await this.card(cardId);
    const filename = file ? checkBoardFile(file) : null;
    const { reply, attachment } = await this.db.transaction().execute(async (trx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = platformDb(trx) as unknown as Kysely<any>;
      const reply: { id: string; created_at: string | Date } = await t
        .insertInto(this.c.replies)
        .values({ [this.c.fk]: cardId, body: input.body, author_id: actor.id ?? null })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();
      const attachment: { id: string; filename: string; content_type: string; size: number } | null =
        file && filename
          ? await t
              .insertInto(this.c.attachments)
              .values({ [this.c.fk]: cardId, reply_id: reply.id, filename, content_type: file.mimetype, size: file.size, content: file.buffer, uploaded_by: actor.id ?? null })
              .returning(['id', 'filename', 'content_type', 'size'])
              .executeTakeFirstOrThrow()
          : null;
      return { reply, attachment };
    });
    await this.audit.platform(`${this.c.auditPrefix}.reply_added`, {
      actor,
      targetType: this.c.targetType,
      targetId: cardId,
      detail: { replyId: reply.id, length: input.body.length, ...(attachment ? { filename: attachment.filename } : {}) },
    });
    const author = actor.id ? await this.q.selectFrom('users').select('display_name').where('id', '=', actor.id).executeTakeFirst() : undefined;
    await this.notify(card, input.body, attachment ? [attachment.filename] : [], author?.display_name ?? actor.email ?? 'Someone', actor, reply.id);
    return {
      id: reply.id,
      body: input.body,
      author_id: actor.id ?? null,
      author_name: author?.display_name ?? null,
      created_at: new Date(reply.created_at).toISOString(),
      attachments: attachment ? [attachment] : [],
    };
  }

  /** Deletes a reply and its file: whoever wrote it, or an administrator. */
  async remove(cardId: string, replyId: string, actor: AuditActor, canManage: boolean) {
    const row: { id: string; author_id: string | null } | undefined = await this.q
      .selectFrom(this.c.replies)
      .select(['id', 'author_id'])
      .where('id', '=', replyId)
      .where(this.c.fk, '=', cardId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Reply not found');
    if (!canManage && (!actor.id || row.author_id !== actor.id)) throw new ForbiddenException('Only whoever wrote this reply, or an administrator, can delete it.');
    await this.q.deleteFrom(this.c.replies).where('id', '=', replyId).execute();
    await this.audit.platform(`${this.c.auditPrefix}.reply_removed`, { actor, targetType: this.c.targetType, targetId: cardId, detail: { replyId } });
    return { ok: true };
  }

  /**
   * Emails the card's owner, everyone else who has replied, and the administrator who last moved the card: the people a reply is for. Not
   * the author, and not anyone whose account is disabled or who can no longer see the board. Email may be switched off; MailService then
   * skips it.
   */
  private async notify(
    card: { id: string; title: string; area: string; owner: string | null; status_changed_by: string | null },
    body: string,
    attachments: string[],
    author: string,
    actor: AuditActor,
    replyId: string,
  ) {
    const reasons = new Map<string, BoardReplyContext['reason']>();
    const add = (id: string | null, reason: BoardReplyContext['reason']) => {
      if (id && id !== actor.id && !reasons.has(id)) reasons.set(id, reason);
    };
    add(card.owner, 'owner');
    const earlier: { author_id: string | null }[] = await this.q
      .selectFrom(this.c.replies)
      .select('author_id')
      .distinct()
      .where(this.c.fk, '=', card.id)
      .where('id', '!=', replyId)
      .execute();
    for (const r of earlier) add(r.author_id, 'thread');
    add(card.status_changed_by, 'worker');
    if (!reasons.size) return;

    const people: { id: string; email: string; display_name: string; role: Role }[] = await this.q
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'role'])
      .where('id', 'in', [...reasons.keys()])
      .where('status', '=', 'active')
      .execute();
    for (const p of people) {
      if (!can(p.role, this.c.readPermission)) continue;
      const context: BoardReplyContext = { board: this.c.board, title: card.title, area: card.area, author, body, attachments, reason: reasons.get(p.id)!, runUrl: this.boardUrl() };
      await this.mail.enqueue({
        template: 'board_reply',
        to: { email: p.email, name: p.display_name },
        context: context as unknown as Record<string, unknown>,
        related: { type: this.c.targetType, id: card.id },
        createdBy: actor.id ?? null,
      });
    }
  }
}
