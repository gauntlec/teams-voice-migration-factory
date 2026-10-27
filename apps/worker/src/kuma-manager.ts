import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { deviceSyncDue, platformDb, recordDeviceSync, saveKumaAdmin, syncDeviceInventory, tenantDb, type DB } from '@tvmf/db';
import { decryptSecret, encryptSecret } from './crypto';
import { KumaClient } from './kuma-client';

/**
 * Device status, phase 2: for each customer whose Kuma Voxshift looks after (Discovery > Device status > "Set up automatically"), make Kuma match the
 * device inventory: sign in (making Kuma's administrator first if Kuma is new), then monitors, tags and the status page (packages/db/src/device-sync.ts).
 * Failures are recorded for the customer to see and retried every minute; nothing here ever throws into the worker.
 */

const KUMA_ADMIN_USER = 'voxshift';

/** Signs in to Kuma, making the administrator first when Kuma has none. The new password is stored (encrypted) BEFORE it is used, so it can never be lost. */
async function signedIn(client: KumaClient, s: ReturnType<typeof tenantDb>, saved: { adminUser: string | null; adminPassEnc: string | null }): Promise<void> {
  if (await client.needSetup()) {
    const password = randomBytes(24).toString('base64url');
    await saveKumaAdmin(s, KUMA_ADMIN_USER, encryptSecret(password));
    await client.setup(KUMA_ADMIN_USER, password);
    await client.login(KUMA_ADMIN_USER, password);
    return;
  }
  if (!saved.adminUser || !saved.adminPassEnc) {
    throw new Error('The monitoring module already has an administrator that Voxshift does not know. Enter that administrator\'s sign-in below.');
  }
  await client.login(saved.adminUser, decryptSecret(saved.adminPassEnc));
}

export async function syncKumaFor(s: ReturnType<typeof tenantDb>): Promise<'skipped' | 'ok' | 'failed'> {
  const due = await deviceSyncDue(s);
  if (!due) return 'skipped';
  let client: KumaClient | null = null;
  try {
    client = await KumaClient.connect(due.url);
    await signedIn(client, s, due);
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
    const tenants = await platformDb(db).selectFrom('tenants').select(['schema_name']).where('status', '=', 'active').execute();
    await Promise.all(
      tenants.map(async (t) => {
        try {
          await syncKumaFor(tenantDb(db, t.schema_name));
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
