import type { Kysely } from 'kysely';
import { platformDb, pollDeviceStatus, tenantDb, type DB } from '@tvmf/db';

/**
 * Device status (docs/DEVICE-MONITORING.md): every few seconds, read each customer's Uptime Kuma status page (when they have switched
 * it on under Discovery > Device status) and record the states. Read-only towards Kuma. A customer whose Kuma is down does not slow the others:
 * the reads run side by side, each with its own timeout, and a run that is still going is not started again.
 */
let running = false;
export async function sweepDeviceStatus(db: Kysely<DB>): Promise<{ polled: number; failed: number }> {
  if (running) return { polled: 0, failed: 0 };
  running = true;
  try {
    const tenants = await platformDb(db).selectFrom('tenants').select(['schema_name']).where('status', '=', 'active').execute();
    const results = await Promise.all(
      tenants.map(async (t) => {
        try {
          return await pollDeviceStatus(tenantDb(db, t.schema_name));
        } catch (e) {
          // A tenant whose schema has not reached migration 0070 yet, or any other database problem: log it and carry on.
          // eslint-disable-next-line no-console
          console.warn(`[device-status] ${t.schema_name}: ${(e as Error).message}`);
          return 'failed' as const;
        }
      }),
    );
    return { polled: results.filter((r) => r === 'ok').length, failed: results.filter((r) => r === 'failed').length };
  } finally {
    running = false;
  }
}
