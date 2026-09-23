import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const DEPLOY_QUEUE = Symbol('DEPLOY_QUEUE');
export const QUEUE_NAME = 'deployments';

export const MAIL_QUEUE = Symbol('MAIL_QUEUE');
export const MAIL_QUEUE_NAME = 'mail';

/** Same ioredis connection BullMQ uses - reused for rate limiting (see LoginRateLimitGuard) rather than opening a second connection. */
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});
const queue = new Queue(QUEUE_NAME, { connection });
const mailQueue = new Queue(MAIL_QUEUE_NAME, { connection });

@Global()
@Module({
  providers: [
    { provide: DEPLOY_QUEUE, useValue: queue },
    { provide: MAIL_QUEUE, useValue: mailQueue },
    { provide: REDIS_CONNECTION, useValue: connection },
  ],
  exports: [DEPLOY_QUEUE, MAIL_QUEUE, REDIS_CONNECTION],
})
export class QueueModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await queue.close();
    await mailQueue.close();
    connection.disconnect();
  }
}

export const InjectDeployQueue = () => Inject(DEPLOY_QUEUE);
export const InjectMailQueue = () => Inject(MAIL_QUEUE);
export const InjectRedis = () => Inject(REDIS_CONNECTION);
export type { Queue };
export type { default as Redis } from 'ioredis';
