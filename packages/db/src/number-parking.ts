import { parkBlockReason, unparkBlockReason } from '@tvmf/shared';
import type { Scoped } from './live-state';
import { refreshNumberConflict } from './number-reconcile';

/*
 * Parked numbers (migration 0082, number-parking.ts in @tvmf/shared): a spare number the customer keeps with the carrier for a
 * retention fee. Parked from the site's Numbers tab while the site is in project mode, and by a completed "Park or unpark phone
 * numbers" service request once it is in operations. A parked number is never claimed by a holder (the claim only takes
 * available numbers), and a Discovery sync that finds it live in Teams flags a conflict instead of taking it over.
 */

export interface ParkResult {
  /** The numbers that changed. Empty when any number could not, because then none do. */
  changed: { id: string; e164: string }[];
  /** Why each number that could not change could not; empty when they all did. */
  blocked: string[];
}

/**
 * Parks (`parked` true) or brings back into use the numbers with these ids. All or nothing: if any one cannot change, none do
 * and `blocked` says why. Run it in a transaction when the caller also records something that must agree with it.
 */
export async function setNumbersParked(s: Scoped, ids: string[], parked: boolean, by: string | null, at = new Date()): Promise<ParkResult> {
  if (!ids.length) return { changed: [], blocked: [] };
  const rows = await s.selectFrom('phone_numbers').select(['id', 'e164', 'status', 'live_status']).where('id', 'in', ids).orderBy('e164').forUpdate().execute();
  const blocked = rows.map((r) => (parked ? parkBlockReason(r) : unparkBlockReason(r))).filter((r): r is string => !!r);
  if (blocked.length) return { changed: [], blocked };
  await s
    .updateTable('phone_numbers')
    .set(parked ? { status: 'parked', parked_at: at.toISOString(), parked_by: by } : { status: 'available', parked_at: null, parked_by: null })
    .where('id', 'in', rows.map((r) => r.id))
    .execute();
  // Back in use, a number Teams already has live shows as assigned again (and any clash is cleared now it is no longer parked).
  if (!parked) for (const r of rows) await refreshNumberConflict(s, r.id);
  return { changed: rows.map((r) => ({ id: r.id, e164: r.e164 })), blocked: [] };
}
