// An installation connected to a hub BEFORE single sign-on existed has the saved connection but no `hub` provider record. The record is
// created from the saved connection (off), whenever the API starts or the SSO settings or login list are read, and an existing one is never touched.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { decryptSecret, encryptSecret } from '../../../../apps/api/src/common/crypto';
import { ensureHubProvider } from '../../../../apps/api/src/sso/hub-provider';
import { hubCredentials, makeSso, seedLocalUser } from './helpers';
import { useDb, useGlobalSettingsLock, useGlobalSsoLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
useGlobalSsoLock(handle);
const sso = makeSso(handle);
const db = platformDb(handle.db);
const creds = hubCredentials();
const HUB = 'https://hub.voxshift.io';

/** A hub connection exactly as the hub connection card saved it, with no provider record (what a pre-SSO installation has). */
async function savePreSsoConnection() {
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
  await db.insertInto('app_settings').values({ id: true, base_url: null, hub_url: HUB, hub_token_enc: encryptSecret(creds.clientSecret), hub_token_hint: '…ab12' } as never).execute();
}
const hubRows = () => db.selectFrom('sso_providers').selectAll().where('kind', '=', 'hub').execute();

beforeEach(savePreSsoConnection);
afterAll(async () => {
  await db.deleteFrom('sso_providers').execute();
  await db.deleteFrom('app_settings').execute();
});

describe('the hub provider for a connection made before single sign-on', () => {
  it('is created, switched off, from the saved connection, and a second run changes nothing', async () => {
    expect(await hubRows()).toHaveLength(0);
    expect(await ensureHubProvider(handle.db)).toBe(true);
    const [p] = await hubRows();
    expect(p).toMatchObject({ name: 'Voxshift Hub', issuer: HUB, client_id: creds.clientId, enabled: false, role_ceiling_staff: 'SUPER_ADMIN', role_ceiling_customer: 'ENGINEER' });
    expect(decryptSecret(p!.client_secret_enc!)).toBe(creds.clientSecret);

    expect(await ensureHubProvider(handle.db)).toBe(false);
    const rows = await hubRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(p); // every column, including updated_at, untouched
  });

  it('never overwrites a record an administrator has already set up', async () => {
    await ensureHubProvider(handle.db);
    await db.updateTable('sso_providers').set({ enabled: true, role_ceiling_staff: 'ENGINEER', jit_create: false }).where('kind', '=', 'hub').execute();
    const before = (await hubRows())[0]!;
    // the saved connection changes behind its back (the connect/disconnect code paths own that); the backfill must not interfere
    await db.updateTable('app_settings').set({ hub_url: 'https://other.example.com' } as never).execute();
    expect(await ensureHubProvider(handle.db)).toBe(false);
    expect((await hubRows())[0]).toEqual(before);
  });

  it('does nothing without a hub connection, or with a token that cannot be read', async () => {
    await db.updateTable('app_settings').set({ hub_url: null, hub_token_enc: null } as never).execute();
    expect(await ensureHubProvider(handle.db)).toBe(false);
    await db.updateTable('app_settings').set({ hub_url: HUB, hub_token_enc: 'garbage' } as never).execute();
    expect(await ensureHubProvider(handle.db)).toBe(false);
    expect(await hubRows()).toHaveLength(0);
    await db.deleteFrom('app_settings').execute();
    expect(await ensureHubProvider(handle.db)).toBe(false);
  });

  it('appears when the SSO settings, the login list or the hub sign-in address is read, and when the API starts', async () => {
    const view = await sso.providers.settings();
    expect(view.providers.find((p) => p.kind === 'hub')).toMatchObject({ enabled: false, clientId: creds.clientId, issuer: HUB, secretSet: true, hubConnected: true });
    expect(JSON.stringify(view)).not.toContain(creds.clientSecret);

    await savePreSsoConnection();
    expect((await sso.providers.publicList()).providers).toEqual([]); // off, so not offered on the login page...
    expect(await hubRows()).toHaveLength(1); // ...but it exists now

    await savePreSsoConnection();
    expect(await sso.providers.hubProviderId()).toBe((await hubRows())[0]!.id);

    await savePreSsoConnection();
    await sso.providers.onModuleInit();
    expect(await hubRows()).toHaveLength(1);
  });

  it('can then be switched on, which was impossible before', async () => {
    const a = await seedLocalUser(handle, 'SUPER_ADMIN', { breakGlass: true });
    const id = await sso.providers.hubProviderId();
    expect(id).toBeTruthy();
    expect(await sso.providers.update(id!, { enabled: true }, { id: a.id })).toMatchObject({ enabled: true, kind: 'hub' });
  });
});
