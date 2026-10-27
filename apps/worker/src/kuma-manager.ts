import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { deviceSyncDue, getMonitoringAdmin, platformDb, recordDeviceSync, saveMonitoringAdmin, syncDeviceInventory, tenantDb, type DB } from '@tvmf/db';
import { decryptSecret, encryptSecret } from './crypto';
import { KumaClient } from './kuma-client';

/**
 * Device status, phase 2: for each customer whose Kuma Voxshift looks after (Discovery > Device status > "Set up automatically"), make Kuma match the
 * device inventory: sign in (making Kuma's administrator first if Kuma is new), then monitors, tags and the status page (packages/db/src/device-sync.ts).
 * Failures are recorded for the customer to see and retried every minute; nothing here ever throws into the worker.
 */

const KUMA_ADMIN_USER = 'voxshift';

/**
 * Signs in to the monitoring module. There is one module (and one administrator) for the whole installation, however many customers use it, so:
 * - a module with no administrator gets one, made by whichever customer comes first; its generated password is stored (encrypted) at installation level BEFORE it
 *   is used, so it can never be lost;
 * - otherwise the installation's administrator is used; and if that is missing or refused but this customer has a working one of its own (made by hand, or by an
 *   earlier release that kept it per customer), that one is used and kept at installation level for every customer.
 */
async function signedIn(client: KumaClient, db: Kysely<DB>, saved: { adminUser: string | null; adminPassEnc: string | null }): Promise<void> {
  if (await client.needSetup()) {
    const password = randomBytes(24).toString('base64url');
    await saveMonitoringAdmin(db, KUMA_ADMIN_USER, encryptSecret(password));
    await client.setup(KUMA_ADMIN_USER, password);
    await client.login(KUMA_ADMIN_USER, password);
    return;
  }
  const shared = await getMonitoringAdmin(db);
  const own = saved.adminUser && saved.adminPassEnc ? { user: saved.adminUser, passEnc: saved.adminPassEnc } : null;
  if (!shared && !own) {
    throw new Error('The monitoring module already has an administrator that Voxshift does not know. Enter that administrator\'s sign-in below.');
  }
  let failure: unknown = null;
  if (shared) {
    try {
      await client.login(shared.user, decryptSecret(shared.passEnc));
      return;
    } catch (e) {
      failure = e;
    }
  }
  if (own) {
    await client.login(own.user, decryptSecret(own.passEnc));
    await saveMonitoringAdmin(db, own.user, own.passEnc);
    return;
  }
  throw failure;
}

export async function syncKumaFor(db: Kysely<DB>, s: ReturnType<typeof tenantDb>, tenantId: string): Promise<'skipped' | 'ok' | 'failed'> {
  const due = await deviceSyncDue(s, new Date(), tenantId);
  if (!due) return 'skipped';
  let client: KumaClient | null = null;
  try {
    client = await KumaClient.connect(due.url);
    await signedIn(client, db, due);
    const r = await syncDeviceInventory(s, client);
    await recordDeviceSync(s, { deviceErrors: r.errors });
    return r.errors ? 'failed' : 'ok';
  } catch (e) {
    await recordDeviceSync(s, { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    return 'failed';
  } finally {
    client?.close();
  }
}

let running = false;
export async function sweepKumaSync(db: Kysely<DB>): Promise<void> {
  if (running) return;
  running = true;
  try {
    const tenants = await platformDb(db).selectFrom('tenants').select(['id', 'schema_name']).where('status', '=', 'active').execute();
    await Promise.all(
      tenants.map(async (t) => {
        try {
          await syncKumaFor(db, tenantDb(db, t.schema_name), t.id);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[kuma-sync] ${t.schema_name}: ${(e as Error).message}`);
        }
      }),
    );
  } finally {
    running = false;
  }
}
