// A port-in range names the carrier it is moving to, tracks the carrier's side of the port, and switches carrier when the port completes.
import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { MailService } from '../../../../apps/api/src/mail/mail.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { TelephonyService } from '../../../../apps/api/src/modules/data-collection/data-collection.telephony.service';
import { NumberPortService } from '../../../../apps/api/src/modules/number-port/number-port.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let tel: TelephonyService;
let port: NumberPortService;
let engineer: Awaited<ReturnType<typeof seedUser>>;
let rangeId: string;

beforeAll(async () => {
  c = await seedCustomer(handle);
  const audit = new AuditService(handle.db);
  tel = new TelephonyService(handle.db, audit, new DataCollectionService(handle.db, audit));
  const mail = new MailService(handle.db, { add: async () => undefined } as never);
  port = new NumberPortService(handle.db, audit, unused('files'), mail, { WEB_ORIGIN: 'https://www.example.test' } as never);
  engineer = await seedUser(handle, 'ENGINEER');
  const site = await seedSite(c.s, { sitecode: 'BOS01' });
  // a customer contact at the site, who is told when the port completes
  await c.s.updateTable('discovery_sites').set({ overview: JSON.stringify({ contacts: { siteContacts: [{ name: 'Pat', email: 'pat@contoso.test' }] } }) } as never).where('id', '=', site.id).execute();
});

const row = () => c.s.selectFrom('discovery_number_ranges').selectAll().where('id', '=', rangeId).executeTakeFirstOrThrow();
const add = (extra: Record<string, unknown>) =>
  tel.addRange(c.t, engineer, { sitecode: 'BOS01', range_start: '+16175550100', range_end: '+16175550109', kind: 'port', carrier: 'Old Carrier', ...extra } as never, true);

describe('the carrier a port-in range moves to', () => {
  it('requires the new carrier for a port-in range, but not for a new or re-point range', async () => {
    await expect(add({})).rejects.toBeInstanceOf(BadRequestException);
    const ok = await add({ new_carrier: 'New Carrier' });
    rangeId = ok.range.id;
    expect(await row()).toMatchObject({ kind: 'port', carrier: 'Old Carrier', new_carrier: 'New Carrier' });
    const fresh = await tel.addRange(c.t, engineer, { sitecode: 'BOS01', range_start: '+16175550200', range_end: '+16175550201', kind: 'new', carrier: 'Any', new_carrier: 'ignored' } as never, true);
    expect(fresh.range.new_carrier).toBeNull();
  });

  it('refuses to turn a range into a port without saying where it is moving to', async () => {
    const fresh = await tel.addRange(c.t, engineer, { sitecode: 'BOS01', range_start: '+16175550300', range_end: '+16175550301', kind: 'new' } as never, true);
    await expect(tel.updateRange(c.t, engineer, fresh.range.id, { kind: 'port' } as never, true)).rejects.toBeInstanceOf(BadRequestException);
    expect((await tel.updateRange(c.t, engineer, fresh.range.id, { kind: 'port', new_carrier: 'NC' } as never, true)).new_carrier).toBe('NC');
  });
});

describe('the carrier side of the port', () => {
  it('moves through with the carrier and scheduled, and taking the submission back clears the date', async () => {
    await port.updatePortDetails(c.t, engineer, rangeId, { portOrderRef: 'PON-123', submittedToCarrier: true });
    expect(await row()).toMatchObject({ port_order_ref: 'PON-123', port_status: 'with_carrier' });
    const sched = await port.updatePortDetails(c.t, engineer, rangeId, { focDate: '2026-11-15' });
    expect(sched.port_status).toBe('scheduled');
    expect((await row()).port_foc_date).toBeTruthy();
    await port.updatePortDetails(c.t, engineer, rangeId, { submittedToCarrier: false });
    expect(await row()).toMatchObject({ port_foc_date: null, port_submitted_to_carrier_at: null });
  });

  it('will not go to the carrier without a new carrier', async () => {
    await c.s.updateTable('discovery_number_ranges').set({ new_carrier: null }).where('id', '=', rangeId).execute();
    await expect(port.updatePortDetails(c.t, engineer, rangeId, { submittedToCarrier: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(port.completePort(c.t, engineer, rangeId, {})).rejects.toBeInstanceOf(BadRequestException);
    await port.updatePortDetails(c.t, engineer, rangeId, { newCarrier: 'New Carrier' });
  });

  it('completing the port switches the carrier, keeps the old one, and tells the site contacts', async () => {
    await port.updatePortDetails(c.t, engineer, rangeId, { focDate: '2026-10-01' });
    await expect(port.completePort(c.t, engineer, rangeId, { completedOn: '2999-01-01' })).rejects.toBeInstanceOf(BadRequestException);
    const done = await port.completePort(c.t, engineer, rangeId, { completedOn: '2026-10-05' });
    expect(done).toMatchObject({ carrier: 'New Carrier', recipients: 1 });
    expect(await row()).toMatchObject({ carrier: 'New Carrier', previous_carrier: 'Old Carrier', port_status: 'ported' });
    expect((await row()).port_completed_at).toBeTruthy();
    await expect(port.completePort(c.t, engineer, rangeId, {})).rejects.toBeInstanceOf(ConflictException);
    await expect(port.updatePortDetails(c.t, engineer, rangeId, { portOrderRef: 'x' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('can be reopened if it was marked complete by mistake', async () => {
    const r = await port.reopenPort(c.t, engineer, rangeId);
    expect(r.port_status).toBe('scheduled');
    expect(await row()).toMatchObject({ carrier: 'Old Carrier', previous_carrier: null, port_completed_at: null });
  });
});
