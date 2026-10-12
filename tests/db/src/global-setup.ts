import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { createDb, migratePlatform } from '@tvmf/db';
import { quietly } from './quiet';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** A free localhost port, so a stray Postgres from an earlier run can't collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts ONE Postgres for the whole run and applies the platform migrations.
 * Tenant schemas are provisioned per test file (see helpers.ts).
 *
 * TEST_DATABASE_URL points the suite at an existing, throwaway database instead
 * (it must be empty or a previous test database - tests create schemas in it).
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;

  if (!url) {
    // ESM-only package - load it with a real dynamic import.
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(join(tmpdir(), 'tvmf-db-test-'));
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: join(dir, 'data'),
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const { pool } = createDb(url);
  try {
    await quietly(() => migratePlatform(pool));
  } catch (err) {
    await stop?.();
    throw err;
  } finally {
    // pool.end(), not handle.close(): Kysely never ran a query here, so its
    // destroy() wouldn't end the pool - and a pool left open crashes the run
    // when Postgres stops under it.
    await pool.end();
  }

  project.provide('databaseUrl', url);
  return async () => {
    await stop?.();
  };
}
