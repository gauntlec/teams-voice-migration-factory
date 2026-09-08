import { Injectable, NotFoundException } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
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

  async enqueue(input: EnqueueMailInput): Promise<{ id: string }> {
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
        created_by: input.createdBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.queue.add('send', { id: row.id }, JOB_OPTS);
    return { id: row.id };
  }

  /** Re-send an existing message (used by "resend invitation"). */
  async resend(id: string): Promise<{ id: string }> {
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
  list(limit = 100) {
    return platformDb(this.db)
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
      ])
      .orderBy('created_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 500))
      .execute();
  }
}
