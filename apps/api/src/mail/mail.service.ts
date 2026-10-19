import { ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { effectiveMail, emailEnabled, platformDb, readMailRow } from '@tvmf/db';
import { sql } from 'kysely';
import type { EmailContext, EmailTemplate } from '@tvmf/shared';
import type { Queue } from 'bullmq';
import { InjectDb, type Db } from '../db/db.module';
import { InjectMailQueue } from '../queue/queue.module';

export interface EnqueueMailInput {
  template: EmailTemplate;
  to: { email: string; name?: string | null };
  context: EmailContext;
  related?: { type: string; id: string };
  createdBy?: string | null;
  /** Which customer this email is for - drives branding at render time. Omit for cross-tenant/platform-level mail (feature/bug status). */
  tenantId?: string | null;
  /** Which MSP this email is for, when the recipient is MSP staff - drives branding at render time. Mutually exclusive with tenantId in practice. */
  mspId?: string | null;
  /** Where a reply goes (an incident's reply address), if not to the sender. */
  replyTo?: string | null;
}

/** BullMQ options: retry a handful of times with growing backoff. */
const JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 15_000 },
  removeOnComplete: 200,
  removeOnFail: 1000,
};

/**
 * Enqueue-side of the email communication module. Persists a row in
 * `platform.email_messages` (the auditable comms log) and drops a job on the
 * `mail` queue; the worker renders + delivers it. See docs/EMAIL.md.
 */
@Injectable()
export class MailService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectMailQueue() private readonly queue: Queue,
  ) {}

  private readonly log = new Logger(MailService.name);

  /**
   * Queues an email. When a Super Admin has switched email off (Administration > Platform settings) nothing is
   * generated: no log row, no job, and the caller gets `id: null`.
   */
  async enqueue(input: EnqueueMailInput): Promise<{ id: string | null }> {
    if (!(await emailEnabled(this.db))) {
      this.log.log(`Email is switched off - not generating "${input.template}" for ${input.to.email}`);
      return { id: null };
    }
    const row = await platformDb(this.db)
      .insertInto('email_messages')
      .values({
        to_email: input.to.email,
        to_name: input.to.name ?? null,
        template: input.template,
        context: input.context as object,
        status: 'queued',
        related_type: input.related?.type ?? null,
        related_id: input.related?.id ?? null,
        tenant_id: input.tenantId ?? null,
        msp_id: input.mspId ?? null,
        created_by: input.createdBy ?? null,
        reply_to: input.replyTo ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.queue.add('send', { id: row.id }, JOB_OPTS);
    return { id: row.id };
  }

  /** Re-send an existing message (the Email log's Resend button). */
  async resend(id: string): Promise<{ id: string }> {
    if (!(await emailEnabled(this.db, { fresh: true }))) throw new ConflictException('Email is switched off for the whole platform (Administration > Platform settings). Switch it on to send.');
    // An invitation's one-time password is removed once the message has been handled, so it cannot be sent again as it was.
    const existing = await platformDb(this.db).selectFrom('email_messages').select(sql<boolean>`context ? 'tempPasswordRemoved'`.as('password_removed')).where('id', '=', id).executeTakeFirst();
    if (existing?.password_removed) throw new ConflictException('This invitation no longer holds its temporary password (it is removed once the email is handled). Use Resend invitation on the Users page: it issues a new password and sends a new email.');
    const row = await platformDb(this.db)
      .updateTable('email_messages')
      .set({ status: 'queued', attempts: 0, error: null, sent_at: null })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('email message not found');
    await this.queue.add('send', { id: row.id }, JOB_OPTS);
    return { id: row.id };
  }

  /** Recent messages for a communications log view. */
  list(limit = 100, search?: string) {
    let q = platformDb(this.db)
      .selectFrom('email_messages')
      .select([
        'id',
        'to_email',
        'to_name',
        'template',
        'subject',
        'status',
        'error',
        'attempts',
        'related_type',
        'related_id',
        'created_at',
        'sent_at',
        'original_to_email',
        // true when this is an invitation whose one-time password has been removed: it cannot be re-sent from here
        sql<boolean>`context ? 'tempPasswordRemoved'`.as('password_removed'),
      ])
      .orderBy('created_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 500));
    if (search) {
      const like = `%${search}%`;
      q = q.where((eb) => eb.or([eb('to_email', 'ilike', like), eb('subject', 'ilike', like), eb('template', 'ilike', like)]));
    }
    return q.execute();
  }

  /** How mail is sent now, for the email log banner. Never the password. */
  async config() {
    const m = effectiveMail(await readMailRow(this.db));
    return { mode: m.mode, configured: m.mode !== 'none', host: m.mode === 'hub' ? 'the Voxshift Hub' : m.host, port: m.port, from: m.from, hasCredentials: m.mode === 'hub' || !!m.user };
  }
}
