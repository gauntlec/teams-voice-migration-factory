// An invitation's one-time password must not stay in platform.email_messages.context (or in the worker log). The API stores it encrypted
// only so the worker can put it in the email; the worker removes it once the message is handled, and migration 0034 removed the
// plaintext ones already there. See docs/EMAIL.md and apps/worker/src/mail/invitation-secret.ts.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { platformDb } from '@tvmf/db';
import { UsersService } from '../../../../apps/api/src/users/users.service';
import { MailService } from '../../../../apps/api/src/mail/mail.service';
import { decryptSecret } from '../../../../apps/worker/src/crypto';
import { renderEmail } from '../../../../apps/worker/src/mail/templates';
import { contextForRender, invitationPasswordMissing, maskSecrets, removeInvitationPassword } from '../../../../apps/worker/src/mail/invitation-secret';
import { makeSso, seedLocalUser } from '../sso/helpers';
import { seedCustomer, useDb, useGlobalSettingsLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle); // reads the platform email switch
const db = platformDb(handle.db);
const queued: unknown[] = [];
const mail = new MailService(handle.db, { add: async (...a: unknown[]) => void queued.push(a) } as never);
const sso = makeSso(handle);
const users = new UsersService(handle.db, sso.audit, mail, sso.cfg);

const messageFor = (userId: string) =>
  db.selectFrom('email_messages').selectAll().where('related_id', '=', userId).where('template', '=', 'user_invitation').orderBy('created_at', 'desc').executeTakeFirstOrThrow();

async function invite() {
  const admin = await seedLocalUser(handle, 'SUPER_ADMIN');
  const cust = await seedCustomer(handle);
  const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
  const created = await users.create({ email, displayName: 'Ivy Invitee', role: 'CUSTOMER', tenantIds: [cust.t.id] } as never, { id: admin.id, email: admin.email, role: 'SUPER_ADMIN' });
  return { created, row: await messageFor(created.id), admin };
}

describe('invitation one-time password', () => {
  it('is stored encrypted, never in plain text, and still renders into the email', async () => {
    const { created, row } = await invite();
    const stored = JSON.stringify(row.context);
    expect(created.tempPassword).toBeTruthy();
    expect(stored).not.toContain(created.tempPassword); // not in the row at all
    const ctx = row.context as Record<string, unknown>;
    expect(ctx.tempPassword).toBeUndefined();
    expect(decryptSecret(ctx.tempPasswordEnc as string)).toBe(created.tempPassword); // the worker can still read it back

    const render = contextForRender(ctx);
    expect(render.tempPasswordEnc).toBeUndefined();
    expect(renderEmail('user_invitation', render).text).toContain(created.tempPassword);
    expect(maskSecrets(renderEmail('user_invitation', render).text, render)).not.toContain(created.tempPassword); // what the worker logs
  });

  it('is removed once the message is handled; the row says so, and a re-send from the log is refused', async () => {
    const { row } = await invite();
    await removeInvitationPassword(handle.db, row.id);
    await removeInvitationPassword(handle.db, row.id); // twice is fine
    const after = (await db.selectFrom('email_messages').select('context').where('id', '=', row.id).executeTakeFirstOrThrow()).context as Record<string, unknown>;
    expect(after.tempPassword).toBeUndefined();
    expect(after.tempPasswordEnc).toBeUndefined();
    expect(after.tempPasswordRemoved).toBe(true);
    expect(after.displayName).toBe('Ivy Invitee'); // the rest of the context is untouched

    expect(invitationPasswordMissing('user_invitation', contextForRender(after))).toBe(true);
    expect(invitationPasswordMissing('mail_test', {})).toBe(false);
    await expect(mail.resend(row.id)).rejects.toThrow(/Resend invitation on the Users page/);
    expect((await mail.list(500)).find((m) => m.id === row.id)?.password_removed).toBe(true);
  });

  it('does not touch the context of other templates', async () => {
    const { id } = await db.insertInto('email_messages').values({ to_email: 'x@example.test', template: 'mail_test', context: { note: 'keep' } as object, status: 'sent' } as never).returning('id').executeTakeFirstOrThrow();
    await removeInvitationPassword(handle.db, id);
    expect((await db.selectFrom('email_messages').select('context').where('id', '=', id).executeTakeFirstOrThrow()).context).toEqual({ note: 'keep' });
  });
});

describe('migration 0034 (scrub invitation passwords)', () => {
  it('removes plain-text passwords from handled invitations and leaves a fresh queued one', async () => {
    const insert = async (status: string, ageDays: number, template = 'user_invitation') =>
      (await db.insertInto('email_messages').values({
        to_email: 'old@example.test', template, status, context: { displayName: 'Old', tempPassword: 'Plain-Text-Secret-1' } as object,
        created_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      } as never).returning('id').executeTakeFirstOrThrow()).id;
    const sent = await insert('sent', 30);
    const failed = await insert('failed', 2);
    const skipped = await insert('skipped', 0);
    const freshQueued = await insert('queued', 0);
    const staleQueued = await insert('queued', 3);
    const otherTemplate = await insert('sent', 30, 'mail_test');

    await sql.raw(readFileSync(new URL('../../../../packages/db/migrations/platform/0034_scrub_invitation_passwords.sql', import.meta.url), 'utf8')).execute(handle.db);

    const ctx = async (id: string) => (await db.selectFrom('email_messages').select('context').where('id', '=', id).executeTakeFirstOrThrow()).context as Record<string, unknown>;
    for (const id of [sent, failed, skipped, staleQueued]) {
      expect(JSON.stringify(await ctx(id))).not.toContain('Plain-Text-Secret-1');
      expect((await ctx(id)).tempPasswordRemoved).toBe(true);
      expect((await ctx(id)).displayName).toBe('Old');
    }
    expect((await ctx(freshQueued)).tempPassword).toBe('Plain-Text-Secret-1'); // not yet delivered: the worker removes it after delivery
    expect((await ctx(otherTemplate)).tempPassword).toBe('Plain-Text-Secret-1'); // only invitations are touched
  });
});
