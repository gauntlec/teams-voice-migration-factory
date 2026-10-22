// Errors are triaged in Design & Build, not at deployment: a user with a blocking problem is left out of
// the run and listed in the change document under "Not deployed"; everyone else still deploys.
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { planIdentityRows } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { seedCustomer, seedSite, seedNumbers, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let siteId: string;
let svc: DeploymentService;

async function tenantUser(upn: string) {
  const obj = await c.s.insertInto('tenant_objects').values({ object_type: 'user', object_key: upn, display_name: upn, data: {} } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.insertInto('tenant_users').values({ object_id: obj.id, upn, display_name: upn, entra_id: `eid-${upn}`, account_enabled: true, enterprise_voice_enabled: false, voicemail_enabled: false } as never).execute();
}
const build = (upn: string, more: Record<string, unknown> = {}) =>
  c.s.insertInto('build_users').values({ site_id: siteId, upn, e164: '+12125550100', number_type: 'CallingPlan', policies: {}, ...more } as never).returning('id').executeTakeFirstOrThrow();

beforeAll(async () => {
  c = await seedCustomer(handle);
  siteId = (await seedSite(c.s, { sitecode: 'NYC01' })).id;
  svc = new DeploymentService(handle.db, unused('queue'), new AuditService(handle.db), unused('files'), new DeploymentDocumentService());
  await tenantUser('good@contoso.test');
  await tenantUser('dupe1@contoso.test');
  await tenantUser('dupe2@contoso.test');
  await tenantUser('asked@contoso.test');
  await tenantUser('disabled@contoso.test');
  await c.s.updateTable('tenant_users').set({ account_enabled: false }).where('upn', '=', 'disabled@contoso.test').execute();
  await build('good@contoso.test', { e164: '+12125550101' });
  await build('dupe1@contoso.test', { e164: '+12125550102' });
  await build('dupe2@contoso.test', { e164: '+12125550102' });
  await build('ghost@contoso.test', { e164: '+12125550103' });
  await build('disabled@contoso.test', { e164: '+12125550104' });
  const [n] = await seedNumbers(c.s, 'NYC01', ['+12125550105']);
  const dc = await c.s.insertInto('discovery_users').values({ site_id: siteId, upn: 'asked@contoso.test', display_name: 'Asked', requested_number: '+12125550999' } as never).returning('id').executeTakeFirstOrThrow();
  await c.s.updateTable('phone_numbers').set({ status: 'assigned', holder_type: 'user', holder_id: dc.id }).where('id', '=', n.id).execute();
  await build('asked@contoso.test', { e164: '+12125550105', discovery_user_id: dc.id });
});

describe('leaving out users with a blocking problem', () => {
  it('flags a user missing from the tenant, a number used twice and a requested number that differs, but not a disabled account', async () => {
    const rows = await planIdentityRows(c.s, 'build_users', 'user', siteId, undefined, true);
    const skipped = Object.fromEntries(rows.filter((r) => r.skipReasons.length).map((r) => [r.upn, r.skipReasons.length]));
    expect(Object.keys(skipped).sort()).toEqual(['asked@contoso.test', 'dupe1@contoso.test', 'dupe2@contoso.test', 'ghost@contoso.test']);
    // the planner is unchanged unless asked
    const plain = await planIdentityRows(c.s, 'build_users', 'user', siteId);
    expect(plain.every((r) => r.skipReasons.length === 0)).toBe(true);
  });

  it('shows them in the preview as not deployed instead of refusing the site', async () => {
    const preview = await svc.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    const by = Object.fromEntries(preview.map((r) => [r.upn, r]));
    expect(by['ghost@contoso.test'].skipReasons?.[0]).toMatch(/tenant/i);
    expect(by['asked@contoso.test'].skipReasons?.[0]).toContain('+12125550999');
    expect(by['good@contoso.test'].skipReasons ?? []).toEqual([]);
    expect(by['disabled@contoso.test'].skipReasons ?? []).toEqual([]);
  });

  it('puts them in their own section of the change document and counts only the others as changes', async () => {
    const preview = await svc.previewChanges(c.t, { siteId, sheets: ['users'] } as never);
    const buf = await new DeploymentDocumentService().build({ tenantName: 'Contoso', siteName: 'New York', sitecode: 'NYC01', mode: 'dry_run', generatedBy: 'Eng', generatedAt: new Date(), rows: preview });
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
    const text = xml.replace(/<[^>]+>/g, '');
    const notDeployedAt = text.indexOf('Not deployed', text.indexOf('Change Recording'));
    expect(notDeployedAt).toBeGreaterThan(-1);
    const after = text.slice(text.lastIndexOf('Not deployed'));
    expect(after).toContain('ghost@contoso.test');
    expect(after).toContain('asked@contoso.test');
    expect(after).not.toContain('good@contoso.test');
    expect(text.slice(0, text.lastIndexOf('Not deployed'))).toContain('good@contoso.test');
  });
});
