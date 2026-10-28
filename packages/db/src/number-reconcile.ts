import { lineUriToNumber } from '@tvmf/shared';
import type { Scoped } from './live-state';

/*
 * Numbers follow Teams (migration 0074). At the end of every Discovery sync, each number Teams has assigned is shown as assigned to its
 * real holder in the number inventory, whatever site it belongs to and whether or not that holder is in Data Collection yet:
 *  - a number in no range is added to a "Found in Teams" range with no site, so it is never offered as free;
 *  - a free number becomes assigned (live_only) until a Data Collection holder claims it;
 *  - when the Data Collection holder (or a reservation) disagrees with Teams, Teams wins and `conflict` says what clashes, for an
 *    engineer to resolve - nothing in the design is overwritten;
 *  - a number Teams no longer has assigned stops being live; if only Teams was holding it, it goes back to available (the cool-off
 *    is started separately, as the sync sees the release).
 */

export interface NumberReconcileResult {
  /** numbers Teams has assigned */
  live: number;
  /** numbers that were in no range and were added */
  added: number;
  /** free numbers now shown as assigned because Teams has them */
  taken: number;
  /** numbers whose Data Collection holder or reservation disagrees with Teams */
  conflicts: number;
  /** numbers Teams no longer has assigned */
  released: number;
}

interface LiveNumber {
  status: string;
  kind: 'user' | 'resource_account' | 'other';
  upn: string | null;
  name: string | null;
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A number as Teams writes it, as +digits; null for an extension-only or unusable value. */
export function normalizeTeamsNumber(raw: unknown): string | null {
  const n = lineUriToNumber(typeof raw === 'string' ? raw : null);
  if (!n) return null;
  const digits = n.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return n.startsWith('+') || n === digits ? `+${digits}` : null;
}

/** Who Teams has each assigned number on, from the `phone_number` objects the sync stored. */
async function liveNumbers(s: Scoped): Promise<Map<string, LiveNumber>> {
  const rows = await s.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'phone_number').where('removed_at', 'is', null).execute();
  const live = new Map<string, LiveNumber>();
  for (const r of rows) {
    const d = (r.data ?? {}) as Rec;
    const status = str(d.PstnAssignmentStatus);
    if (!status || /^unassigned$/i.test(status)) continue;
    const e164 = normalizeTeamsNumber(d.TelephoneNumber ?? r.object_key);
    if (!e164) continue;
    const who = (d.AssignedTo ?? null) as Rec | null;
    const kind = who?.kind === 'user' || who?.kind === 'resource_account' ? who.kind : 'other';
    live.set(e164, { status, kind, upn: str(who?.upn)?.toLowerCase() ?? null, name: str(who?.displayName) });
  }
  return live;
}

type HolderRow = { holder_type: string | null; holder_id: string | null };
interface Holder {
  upn: string | null;
  name: string | null;
}

/** The Data Collection holders (user, common area phone, resource account) of these numbers. */
async function designHolders(s: Scoped, rows: HolderRow[]): Promise<Map<string, Holder>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.holder_type === type && r.holder_id).map((r) => r.holder_id as string))];
  const out = new Map<string, Holder>();
  const users = ids('user');
  if (users.length) for (const u of await s.selectFrom('discovery_users').select(['id', 'upn', 'display_name']).where('id', 'in', users).execute()) out.set(u.id, { upn: u.upn?.toLowerCase() ?? null, name: u.display_name || u.upn });
  const caps = ids('cap');
  if (caps.length) for (const c of await s.selectFrom('discovery_caps').select(['id', 'upn', 'display_name']).where('id', 'in', caps).execute()) out.set(c.id, { upn: c.upn?.toLowerCase() ?? null, name: c.display_name });
  const ras = ids('resource_account');
  if (ras.length) for (const r of await s.selectFrom('discovery_resource_accounts').select(['id', 'upn', 'name']).where('id', 'in', ras).execute()) out.set(r.id, { upn: r.upn?.toLowerCase() ?? null, name: r.name });
  // Design & Build rows claim numbers under their own ids, so look there for any holder the Data Collection tables did not know.
  const unknown = (type: string) => ids(type).filter((id) => !out.has(id));
  const bUsers = unknown('user');
  if (bUsers.length) for (const u of await s.selectFrom('build_users').select(['id', 'upn']).where('id', 'in', bUsers).execute()) out.set(u.id, { upn: u.upn?.toLowerCase() ?? null, name: u.upn });
  const bCaps = unknown('cap');
  if (bCaps.length) for (const c of await s.selectFrom('build_caps').select(['id', 'upn', 'display_name']).where('id', 'in', bCaps).execute()) out.set(c.id, { upn: c.upn?.toLowerCase() ?? null, name: c.display_name ?? c.upn });
  const bRas = unknown('resource_account');
  if (bRas.length) for (const r of await s.selectFrom('build_resource_accounts').select(['id', 'upn', 'display_name']).where('id', 'in', bRas).execute()) out.set(r.id, { upn: r.upn?.toLowerCase() ?? null, name: r.display_name ?? r.upn });
  return out;
}

const liveLabel = (l: Pick<LiveNumber, 'name' | 'upn'>) => l.name ?? l.upn ?? 'another object';

/**
 * The clash between what Teams has and what Data Collection has, in words; null when they agree or cannot be compared (a live
 * holder Voxshift does not know - e.g. an unlicensed user the sync skips - or a Data Collection holder with no UPN).
 */
export function numberConflict(row: { status: string; holder_type: string | null; holder_id: string | null }, design: Holder | undefined, live: LiveNumber | null): string | null {
  if (!live) return null;
  const on = liveLabel(live);
  if (!row.holder_id) return row.status === 'reserved' ? `Live in Teams on ${on}, but reserved here.` : null;
  if (row.holder_type === 'analogue') return `Live in Teams on ${on}, but Data Collection has it as an analogue line.`;
  if (!design?.upn || !live.upn) return null;
  return design.upn === live.upn ? null : `Live in Teams on ${on}, but Data Collection has it for ${design.name ?? design.upn}.`;
}

/** Brings the inventory in line with Teams. `releaseMissing`: also stop treating numbers Teams no longer lists as live (only when the sync read every number). */
export async function reconcileNumbersWithTeams(s: Scoped, opts: { releaseMissing: boolean; now?: Date }): Promise<NumberReconcileResult> {
  const now = (opts.now ?? new Date()).toISOString();
  const live = await liveNumbers(s);
  const result: NumberReconcileResult = { live: live.size, added: 0, taken: 0, conflicts: 0, released: 0 };

  const existing = await s
    .selectFrom('phone_numbers')
    .select(['id', 'e164', 'status', 'holder_type', 'holder_id', 'live_status', 'live_holder_kind', 'live_holder_upn', 'live_holder_name', 'live_only', 'conflict', 'cooling_until'])
    .execute();
  const byE164 = new Map(existing.map((r) => [r.e164, r]));

  // Numbers in no range: a range per run of consecutive numbers, with no site.
  const missing = [...live.keys()].filter((n) => !byE164.has(n)).sort((a, b) => (BigInt(a.slice(1)) < BigInt(b.slice(1)) ? -1 : 1));
  for (let i = 0; i < missing.length; ) {
    let j = i;
    while (j + 1 < missing.length && BigInt(missing[j + 1]!.slice(1)) === BigInt(missing[j]!.slice(1)) + 1n) j++;
    const group = missing.slice(i, j + 1);
    const range = await s
      .insertInto('discovery_number_ranges')
      .values({ range_start: group[0]!, range_end: group[group.length - 1]!, kind: 'retain', sitecode: null, comments: 'Found in Teams by Discovery: assigned there, but in none of our ranges.' } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    for (let k = 0; k < group.length; k += 500) {
      const chunk = group.slice(k, k + 500);
      const inserted = await s
        .insertInto('phone_numbers')
        .values(chunk.map((e164) => ({ range_id: range.id, e164, status: 'assigned', live_only: true })) as never)
        .returning(['id', 'e164', 'status', 'holder_type', 'holder_id', 'live_status', 'live_holder_kind', 'live_holder_upn', 'live_holder_name', 'live_only', 'conflict', 'cooling_until'])
        .execute();
      for (const r of inserted) byE164.set(r.e164, r);
    }
    result.added += group.length;
    i = j + 1;
  }

  const design = await designHolders(s, [...byE164.values()]);
  for (const [e164, l] of live) {
    const row = byE164.get(e164)!;
    const liveOnly = !row.holder_id && row.status !== 'reserved';
    if (liveOnly && row.status === 'available') result.taken += 1;
    const conflict = numberConflict({ status: row.status, holder_type: row.holder_type, holder_id: row.holder_id }, row.holder_id ? design.get(row.holder_id) : undefined, l);
    if (conflict) result.conflicts += 1;
    const same =
      row.live_status === l.status && row.live_holder_kind === l.kind && row.live_holder_upn === l.upn && row.live_holder_name === l.name && row.live_only === liveOnly && (row.conflict ?? null) === conflict && !row.cooling_until;
    if (same) continue;
    await s
      .updateTable('phone_numbers')
      .set({
        status: liveOnly ? 'assigned' : row.status,
        live_status: l.status,
        live_holder_kind: l.kind,
        live_holder_upn: l.upn,
        live_holder_name: l.name,
        live_seen_at: now,
        live_only: liveOnly,
        conflict,
        cooling_until: null,
        cooling_reason: null,
      })
      .where('id', '=', row.id)
      .execute();
  }

  if (opts.releaseMissing) {
    for (const row of existing) {
      if (live.has(row.e164) || (!row.live_status && !row.conflict && !row.live_only)) continue;
      result.released += row.live_status ? 1 : 0;
      await s
        .updateTable('phone_numbers')
        .set({
          status: row.live_only && !row.holder_id ? 'available' : row.status,
          live_status: null,
          live_holder_kind: null,
          live_holder_upn: null,
          live_holder_name: null,
          live_seen_at: null,
          live_only: false,
          conflict: null,
        })
        .where('id', '=', row.id)
        .execute();
    }
  }
  return result;
}

/**
 * Recomputes one number's `live_only` and `conflict` straight after a holder claimed or released it (the sync would do it on its
 * next run; this keeps the Numbers page right in between). A number Teams does not have live is left as it is.
 */
export async function refreshNumberConflict(s: Scoped, numberId: string): Promise<void> {
  const row = await s
    .selectFrom('phone_numbers')
    .select(['id', 'status', 'holder_type', 'holder_id', 'live_status', 'live_holder_upn', 'live_holder_name'])
    .where('id', '=', numberId)
    .executeTakeFirst();
  if (!row?.live_status) return;
  const design = row.holder_id ? (await designHolders(s, [row])).get(row.holder_id) : undefined;
  const liveRow: LiveNumber = { status: row.live_status, kind: 'other', upn: row.live_holder_upn, name: row.live_holder_name };
  const conflict = numberConflict(row, design, liveRow);
  const liveOnly = !row.holder_id && row.status !== 'reserved';
  await s
    .updateTable('phone_numbers')
    .set({ live_only: liveOnly, conflict, status: liveOnly ? 'assigned' : row.status })
    .where('id', '=', numberId)
    .execute();
}
