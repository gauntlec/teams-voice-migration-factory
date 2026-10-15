// The first Super Admin is created once; later starts must not undo what people changed (docs/INSTALL-LINUX.md).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import { platformDb } from '@tvmf/db';
import { seedBootstrapAdmin } from '../../../../packages/db/src/bootstrap-admin';
import { useDb } from '../helpers';

const handle = useDb();
const row = (email: string) => platformDb(handle.db).selectFrom('users').selectAll().where('email', '=', email).executeTakeFirstOrThrow();

describe('bootstrap admin', () => {
  it('sets the password on first start only, and leaves a changed account alone on every later start', async () => {
    const email = `boot-${randomUUID().slice(0, 8)}@msp.test`;
    const first = await seedBootstrapAdmin(handle.pool, { email, password: 'first-password-1234', reset: false });
    expect(first.action).toBe('created');
    expect(await argon2.verify((await row(email)).password_hash, 'first-password-1234')).toBe(true);

    // The admin changes their password, and someone changes their role/status: a restart must not undo any of it.
    const changed = await argon2.hash('my-own-new-password-99');
    await platformDb(handle.db).updateTable('users').set({ password_hash: changed, role: 'ENGINEER', status: 'disabled' } as never).where('email', '=', email).execute();
    const again = await seedBootstrapAdmin(handle.pool, { email, password: 'first-password-1234', reset: false });
    expect(again).toEqual({ action: 'unchanged', id: first.id });
    const after = await row(email);
    expect(after.password_hash).toBe(changed);
    expect(after.role).toBe('ENGINEER');
    expect(after.status).toBe('disabled');
  });

  it('does not need the password in the environment once the account exists', async () => {
    const email = `boot-${randomUUID().slice(0, 8)}@msp.test`;
    await seedBootstrapAdmin(handle.pool, { email, password: 'first-password-1234', reset: false });
    expect((await seedBootstrapAdmin(handle.pool, { email, password: '', reset: false })).action).toBe('unchanged');
    // ...but creating one needs it
    await expect(seedBootstrapAdmin(handle.pool, { email: `new-${email}`, password: '', reset: false })).rejects.toThrow(/needed to create/);
  });

  it('puts the account back only when asked to reset', async () => {
    const email = `boot-${randomUUID().slice(0, 8)}@msp.test`;
    const made = await seedBootstrapAdmin(handle.pool, { email, password: 'first-password-1234', reset: false });
    await platformDb(handle.db).updateTable('users').set({ role: 'ENGINEER', status: 'disabled', failed_logins: 7 } as never).where('email', '=', email).execute();
    const r = await seedBootstrapAdmin(handle.pool, { email: email.toUpperCase(), password: 'recovery-password-77', reset: true });
    expect(r).toEqual({ action: 'reset', id: made.id });
    const u = await row(email);
    expect(await argon2.verify(u.password_hash, 'recovery-password-77')).toBe(true);
    expect([u.role, u.status, u.failed_logins]).toEqual(['SUPER_ADMIN', 'active', 0]);
    await expect(seedBootstrapAdmin(handle.pool, { email, password: 'short', reset: true })).rejects.toThrow(/at least 12/);
  });

  it('matches the email without regard to case', async () => {
    const email = `boot-${randomUUID().slice(0, 8)}@msp.test`;
    const a = await seedBootstrapAdmin(handle.pool, { email, password: 'first-password-1234', reset: false });
    const b = await seedBootstrapAdmin(handle.pool, { email: email.toUpperCase(), password: 'first-password-1234', reset: false });
    expect(b).toEqual({ action: 'unchanged', id: a.id });
  });
});
