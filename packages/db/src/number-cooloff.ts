import { sql } from 'kysely';
import type { Scoped } from './live-state';

/*
 * Number cool-off (migration 0066): a number released in Teams is not given to someone else for the customer's cool-off
 * period (number_policy.cooloff_days, 0 = off), so its new holder does not get calls meant for the previous one. Started by a
 * Discovery sync that sees a number go from assigned to unassigned (numberReleasedInTeams); claiming a cooling number is
 * refused until it ends or an engineer ends it with a reason.
 */

export async function cooloffDays(s: Scoped): Promise<number> {
  const r = await s.selectFrom('number_policy').select('cooloff_days').executeTakeFirst();
  return r?.cooloff_days ?? 90;
}

/** Starts the cool-off for these numbers (E.164, as Teams writes them) in the inventory. Returns how many inventory numbers it marked. */
export async function markNumbersReleased(s: Scoped, e164s: string[], reason: string, at = new Date()): Promise<number> {
  if (!e164s.length) return 0;
  const days = await cooloffDays(s);
  if (days <= 0) return 0;
  const until = new Date(at.getTime() + days * 86400_000).toISOString();
  const res = await s
    .updateTable('phone_numbers')
    .set({ cooling_until: until, cooling_reason: reason })
    .where('e164', 'in', [...new Set(e164s)])
    .where((eb) => eb.or([eb('cooling_until', 'is', null), eb('cooling_until', '<', until)]))
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** The cool-off end of a number that is still cooling, or null. */
export async function coolingUntil(s: Scoped, numberId: string): Promise<string | null> {
  const r = await s
    .selectFrom('phone_numbers')
    .select('cooling_until')
    .where('id', '=', numberId)
    .where('cooling_until', '>', sql<string>`now()`)
    .executeTakeFirst();
  return r?.cooling_until ? new Date(r.cooling_until).toISOString() : null;
}
