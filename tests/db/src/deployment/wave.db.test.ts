// The Deployment preview says which migration wave each user and common area phone is in, so the page can group by wave.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { seedCustomer, seedSite, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let siteId: string;
let svc: DeploymentService;

async function tenantUser(upn: string) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: false, voicemail_enabled: false } as never).execute();
}

beforeAll(async () => {
  c = await seedCustomer(handle);
  siteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  svc = new DeploymentService(handle.db, unused('queue'), new AuditService(handle.db), unused('files'), new DeploymentDocumentService());
  for (const [upn, wave] of [['a@contoso.test', 'Wave 2'], ['b@contoso.test', ' Wave 10 '], ['c@contoso.test', null]] as const) {
    await tenantUser(upn);
    await c.s.insertInto('build_users').values({ site_id: siteId, upn, e164: null, policies: {}, voicemail: { enabled: true, language: 'en-US' }, migration_wave: wave, validation: {}, status: {} } as never).execute();
  }
});

describe('preview rows carry their migration wave', () => {
  it('has the wave (trimmed) for a user in one and null for a user with none', async () => {
    const rows = await svc.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    const wave = Object.fromEntries(rows.map((r) => [r.upn, r.wave]));
    expect(wave).toEqual({ 'a@contoso.test': 'Wave 2', 'b@contoso.test': 'Wave 10', 'c@contoso.test': null });
  });
});
