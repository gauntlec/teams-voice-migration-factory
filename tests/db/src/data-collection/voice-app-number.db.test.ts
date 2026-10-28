// Adding a voice app by hand with a telephone number: a resource account of the same name is made to hold the number and answers for the app.
// A number that cannot be taken leaves nothing behind.
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { seedCustomer, seedNumbers, seedSite, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let svc: TelephonyService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let site: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  engineer = await seedUser(handle, 'ENGINEER');
  site = (await seedSite(c.s, { sitecode: 'LON01' })).id;
  const audit = new AuditService(handle.db);
  svc = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
});

const apps = () => c.s.selectFrom('discovery_voice_apps').select(['id', 'name']).execute();
const ras = () => c.s.selectFrom('discovery_resource_accounts').select(['id', 'name', 'kind', 'voice_app_id']).execute();

describe('voice app added with a telephone number', () => {
  it('makes a resource account that holds the number and answers for the app', async () => {
    const [n] = await seedNumbers(c.s, 'LON01', ['+442070000201']);
    const app = await svc.addVoiceApp(c.t, engineer, { site_id: site, name: 'Main Line', kind: 'auto_attendant', phone_number_id: n!.id } as never, true);
    const made = await ras();
    expect(made).toEqual([{ id: expect.any(String), name: 'Main Line', kind: 'auto_attendant', voice_app_id: app.id }]);
    const num = await c.s.selectFrom('phone_numbers').select(['status', 'holder_type', 'holder_id']).where('id', '=', n!.id).executeTakeFirstOrThrow();
    expect(num).toEqual({ status: 'assigned', holder_type: 'resource_account', holder_id: made[0]!.id });
  });

  it('adds just the app when no number is given', async () => {
    const before = (await ras()).length;
    await svc.addVoiceApp(c.t, engineer, { site_id: site, name: 'No Number', kind: 'call_queue' } as never, true);
    expect((await ras()).length).toBe(before);
    expect((await apps()).map((a) => a.name)).toContain('No Number');
  });

  it('leaves nothing behind when the number is already taken', async () => {
    const [n] = await seedNumbers(c.s, 'LON01', ['+442070000202']);
    await svc.addVoiceApp(c.t, engineer, { site_id: site, name: 'First', kind: 'auto_attendant', phone_number_id: n!.id } as never, true);
    const appsBefore = (await apps()).length;
    const rasBefore = (await ras()).length;
    await expect(svc.addVoiceApp(c.t, engineer, { site_id: site, name: 'Second', kind: 'auto_attendant', phone_number_id: n!.id } as never, true)).rejects.toThrow();
    expect((await apps()).length).toBe(appsBefore);
    expect((await ras()).length).toBe(rasBefore);
  });
});
