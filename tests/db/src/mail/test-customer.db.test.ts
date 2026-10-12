// Test customers (platform.tenants.sandbox): the worker's mail sender redirects
// every email for one to whoever triggered it, subject-prefixed with the real
// recipient. planDelivery is what handleMail (apps/worker/src/main.ts) asks.
import { beforeAll, describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { planDelivery } from '../../../../apps/worker/src/mail/sandbox';
import { seedCustomer, seedUser, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let real: TestCustomer;
let test: TestCustomer;

beforeAll(async () => {
  real = await seedCustomer(handle, { name: 'Real Co' });
  test = await seedCustomer(handle, { name: 'Test Co' });
  await platformDb(handle.db).updateTable('tenants').set({ sandbox: true }).where('id', '=', test.t.id).execute();
});

const setFallback = (email: string | null) =>
  platformDb(handle.db).updateTable('tenants').set({ sandbox_email: email }).where('id', '=', test.t.id).execute();

const row = (over: Partial<Parameters<typeof planDelivery>[1]>) => ({
  to_email: 'customer.contact@realcustomer.example',
  to_name: 'Customer Contact',
  tenant_id: null,
  created_by: null,
  original_to_email: null,
  ...over,
});

describe('planDelivery', () => {
  it('leaves a real customer and platform-level mail alone', async () => {
    const engineer = await seedUser(handle, 'ENGINEER');
    for (const tenant_id of [real.t.id, null]) {
      expect(await planDelivery(handle.db, row({ tenant_id, created_by: engineer.id }), 'Your request was updated')).toEqual({
        action: 'send',
        to: 'customer.contact@realcustomer.example',
        toName: 'Customer Contact',
        subject: 'Your request was updated',
        originalTo: null,
      });
    }
  });

  it('sends a test customer email to the person who triggered it', async () => {
    const engineer = await seedUser(handle, 'ENGINEER', { displayName: 'Tess Tester' });
    await setFallback('qa-inbox@msp.test');
    expect(await planDelivery(handle.db, row({ tenant_id: test.t.id, created_by: engineer.id }), 'Your request was updated')).toEqual({
      action: 'send',
      to: engineer.email,
      toName: 'Tess Tester',
      subject: '[TEST - would have gone to customer.contact@realcustomer.example] Your request was updated',
      originalTo: 'customer.contact@realcustomer.example',
    });
  });

  it('sends an email nobody triggered (a reminder) to the fallback address, or skips it', async () => {
    await setFallback('qa-inbox@msp.test');
    expect(await planDelivery(handle.db, row({ tenant_id: test.t.id }), 'Reminder')).toMatchObject({
      action: 'send',
      to: 'qa-inbox@msp.test',
      subject: '[TEST - would have gone to customer.contact@realcustomer.example] Reminder',
    });
    await setFallback(null);
    expect(await planDelivery(handle.db, row({ tenant_id: test.t.id }), 'Reminder')).toMatchObject({
      action: 'skip',
      originalTo: 'customer.contact@realcustomer.example',
    });
  });

  it('a resend starts from the real recipient - redirected again while a test customer, delivered once it is not', async () => {
    const engineer = await seedUser(handle, 'ENGINEER');
    const resent = row({ tenant_id: test.t.id, created_by: engineer.id, to_email: engineer.email, original_to_email: 'customer.contact@realcustomer.example' });
    expect(await planDelivery(handle.db, resent, 'Hello')).toMatchObject({
      to: engineer.email,
      subject: '[TEST - would have gone to customer.contact@realcustomer.example] Hello', // not double-prefixed or "would have gone to" the engineer
    });

    await platformDb(handle.db).updateTable('tenants').set({ sandbox: false }).where('id', '=', test.t.id).execute();
    try {
      expect(await planDelivery(handle.db, resent, 'Hello')).toMatchObject({ to: 'customer.contact@realcustomer.example', subject: 'Hello', originalTo: null });
    } finally {
      await platformDb(handle.db).updateTable('tenants').set({ sandbox: true }).where('id', '=', test.t.id).execute();
    }
  });
});
