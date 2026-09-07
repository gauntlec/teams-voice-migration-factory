import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { createDb, type DB } from '@tvmf/db';
import type { Kysely } from 'kysely';
import type { Pool } from 'pg';

export const KYSELY = Symbol('KYSELY');
export const PG_POOL = Symbol('PG_POOL');

const handle = createDb();

@Global()
@Module({
  providers: [
    { provide: KYSELY, useValue: handle.db },
    { provide: PG_POOL, useValue: handle.pool },
  ],
  exports: [KYSELY, PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await handle.close();
  }
}

export type Db = Kysely<DB>;
export type { Pool };

/** Small helper for injecting the Kysely instance. */
export const InjectDb = () => Inject(KYSELY);
export const InjectPool = () => Inject(PG_POOL);
