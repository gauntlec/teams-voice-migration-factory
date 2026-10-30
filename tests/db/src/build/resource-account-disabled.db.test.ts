// A resource account's account is disabled by design (Teams creates it that way and it never signs in), so validation does not warn about
// it. A person's disabled account still gets the warning.
import { beforeAll, describe, expect, it } from 'vitest';
import { validateIdentityRows } from '@tvmf/db';
import { seedCustomer, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;

async function disabledTenantAccount(upn: string) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: false, enterprise_voice_enabled: false, voicemail_enabled: false } as never).execute();
}
const row = (id: string, upn: string, more: Record<string, unknown> = {}) => ({ id, upn, e164: null, number_type: null, policies: {}, policy_ids: {}, ...more });

beforeAll(async () => {
  c = await seedCustomer(handle);
  await disabledTenantAccount('ra-main@contoso.test');
  await disabledTenantAccount('leaver@contoso.test');
});

describe('a disabled account', () => {
  it('is not flagged for a resource account', async () => {
    const v = await validateIdentityRows(c.s, [row('ra', 'ra-main@contoso.test', { resourceAccount: true, needsPhoneLicence: false })]);
    expect(v.get('ra')!.accountDisabled).toBe(false);
  });
  it('is still flagged for a person', async () => {
    const v = await validateIdentityRows(c.s, [row('user', 'leaver@contoso.test')]);
    expect(v.get('user')!.accountDisabled).toBe(true);
  });
});
