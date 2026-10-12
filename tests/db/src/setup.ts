import { inject, vi } from 'vitest';

// apps/api's db.module builds its own pool from DATABASE_URL as soon as it is
// imported. Tests pass their own Kysely instance to each service; this only
// has to be set so that import doesn't throw.
process.env.DATABASE_URL = inject('databaseUrl');

// apps/api's queue.module opens a Redis connection on import (BullMQ). Tests
// hand services a fake queue instead, so replace the module with its exports
// minus the connection.
vi.mock('../../../apps/api/src/queue/queue.module', async () => {
  const { Inject } = await import('@nestjs/common');
  const DEPLOY_QUEUE = Symbol('DEPLOY_QUEUE');
  const MAIL_QUEUE = Symbol('MAIL_QUEUE');
  const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
  return {
    DEPLOY_QUEUE,
    QUEUE_NAME: 'deployments',
    MAIL_QUEUE,
    MAIL_QUEUE_NAME: 'mail',
    REDIS_CONNECTION,
    QueueModule: class QueueModule {},
    InjectDeployQueue: () => Inject(DEPLOY_QUEUE),
    InjectMailQueue: () => Inject(MAIL_QUEUE),
    InjectRedis: () => Inject(REDIS_CONNECTION),
  };
});
