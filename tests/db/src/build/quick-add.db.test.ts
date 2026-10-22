// Quick add: type only UPNs and each row is imported from the discovered tenant data.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { BuildValidationService } from '../../../../apps/api/src/modules/build/build-validation.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let siteId: string;

async function tenantUser(upn: string, name: string, more: Record<string, unknown> = {}) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: name, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: name, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: false, voicemail_enabled: null, ...more } as never).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  siteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  build = new BuildService(handle.db, new AuditService(handle.db), new BuildValidationService(handle.db), unused('discovery'), unused('documentBuilder'), unused('files'));
});

describe('quick add', () => {
  it('imports the number, policies, voicemail and Data Collection link from the discovered data', async () => {
    const pol = await c.s.insertInto('tenant_objects').values({ object_type: 'policy', object_key: 'TeamsCallingPolicy:AllowCalling', display_name: 'AllowCalling', data: {} } as never).returning('id').executeTakeFirstOrThrow();
    const policy = await c.s.insertInto('tenant_policies').values({ object_id: pol.id, policy_type: 'TeamsCallingPolicy', identity: 'Tag:AllowCalling', name: 'AllowCalling', data: {} } as never).returning('id').executeTakeFirstOrThrow();
    const [n] = await seedNumbers(c.s, 'NYC01', ['+12125550111']);
    await tenantUser('ann@contoso.test', 'Ann Lee', { enterprise_voice_enabled: true, line_uri: 'tel:+12125550111', policies: { TeamsCallingPolicy: 'AllowCalling' }, voicemail_enabled: true, voicemail_prompt_language: 'en-US' });
    const dc = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'ann@contoso.test', display_name: 'Ann Lee' } as never).returning('id').executeTakeFirstOrThrow();

    const res = await build.quickAddUsers(c.t, engineer, siteId, ['Ann@Contoso.test']);
    expect(res.added).toMatchObject([{ upn: 'ann@contoso.test', displayName: 'Ann Lee', number: '+12125550111' }]);

    const row = await c.s.selectFrom('build_users').selectAll().where('upn', '=', 'ann@contoso.test').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ e164: '+12125550111', phone_number_id: n.id, discovery_user_id: dc.id });
    expect(row.policies).toMatchObject({ calling_policy: 'AllowCalling' });
    expect(row.policy_ids).toMatchObject({ calling_policy: policy.id });
    expect(row.voicemail).toEqual({ enabled: true, language: 'en-US' });
    // the number is a copy: Data Collection's inventory claim is untouched
    expect((await c.s.selectFrom('phone_numbers').select('status').where('id', '=', n.id).executeTakeFirstOrThrow()).status).toBe('available');
  });

  it('adds several at once, sorts out repeats, and reports what it could not find', async () => {
    await tenantUser('bob@contoso.test', 'Bob Ray');
    await tenantUser('cy@contoso.test', 'Cy Dee');
    const res = await build.quickAddUsers(c.t, engineer, siteId, ['bob@contoso.test, cy@contoso.test\nann@contoso.test', 'ghost@contoso.test', 'not a upn', 'bob@contoso.test']);
    expect(res.added.map((a) => a.upn).sort()).toEqual(['bob@contoso.test', 'cy@contoso.test']);
    expect(res.alreadyThere).toEqual(['ann@contoso.test']);
    expect(res.notFound.sort()).toEqual(['ghost@contoso.test', 'not', 'upn', 'a'].sort());
    const bob = await c.s.selectFrom('build_users').selectAll().where('upn', '=', 'bob@contoso.test').executeTakeFirstOrThrow();
    expect(bob).toMatchObject({ e164: null, number_type: null });
  });

  it('adds a common area phone with its name from the tenant', async () => {
    await tenantUser('lobby@contoso.test', 'Lobby Phone');
    const res = await build.quickAddCaps(c.t, engineer, siteId, ['lobby@contoso.test']);
    expect(res.added).toHaveLength(1);
    const cap = await c.s.selectFrom('build_caps').selectAll().where('upn', '=', 'lobby@contoso.test').executeTakeFirstOrThrow();
    expect(cap.display_name).toBe('Lobby Phone');
  });
});
