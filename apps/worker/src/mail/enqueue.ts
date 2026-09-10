import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import type { EmailTemplate } from '@tvmf/shared';

/**
 * Producer side of the `mail` queue for jobs the *worker* originates (e.g. the
 * discovery-run completion email). The API's `MailService.enqueue` does the same
 * thing from the other side; kept in sync with it and with docs/EMAIL.md.
 */

const MAIL_QUEUE_NAME = 'mail';

/** Same retry policy as `apps/api/src/mail/mail.service.ts`. */
const JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 15_000 },
  removeOnComplete: 200,
  removeOnFail: 1000,
};

export interface EnqueueMailInput {
  template: EmailTemplate;
  to: { email: string; name?: string | null };
  /** the template's context object; shape is checked by the renderer */
  context: object;
  related?: { type: string; id: string };
  createdBy?: string | null;
}

export type MailEnqueuer = (input: EnqueueMailInput) => Promise<void>;

/** Bind a mail enqueuer to the shared db + redis connection. */
export function makeMailEnqueuer(db: Kysely<DB>, connection: IORedis): MailEnqueuer {
  const queue = new Queue(MAIL_QUEUE_NAME, { connection });
  return async (input) => {
    const row = await platformDb(db)
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
    await queue.add('send', { id: row.id }, JOB_OPTS);
  };
}
