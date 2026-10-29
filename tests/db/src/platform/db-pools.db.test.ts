// The worker's pools (apps/worker/src/main.ts): a discovery sync writes through a pool whose commits do not wait for the disk, so the
// website is not queued behind its flushes; everything else keeps full durability.
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb, type DbHandle } from '@tvmf/db';

const opened: DbHandle[] = [];
const open = (opts?: Parameters<typeof createDb>[1]) => {
  const h = createDb(inject('databaseUrl'), opts);
  opened.push(h);
  return h;
};
afterAll(() => Promise.all(opened.map((h) => h.pool.end())));

const setting = async (h: DbHandle) => (await h.pool.query<{ synchronous_commit: string }>('show synchronous_commit')).rows[0]!.synchronous_commit;

describe('database pools', () => {
  it('a sync pool does not wait for the disk on commit; the default pool does', async () => {
    expect(await setting(open({ max: 3, synchronousCommit: false }))).toBe('off');
    expect(await setting(open({ max: 5 }))).toBe('on');
  });

  it('uses the pool size it is given, whatever PG_POOL_MAX says', () => {
    const before = process.env.PG_POOL_MAX;
    process.env.PG_POOL_MAX = '40';
    try {
      expect(open({ max: 5 }).pool.options.max).toBe(5);
      expect(open().pool.options.max).toBe(40);
    } finally {
      if (before === undefined) delete process.env.PG_POOL_MAX;
      else process.env.PG_POOL_MAX = before;
    }
  });
});
