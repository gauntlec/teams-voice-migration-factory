/*
 * Handset tracker (site Overview). The handsets a site needs are counted from Data Collection: a user with a handset model, and a
 * common area phone's device model. The project manager tracks each model through the stages below.
 */

export const HANDSET_STAGES = ['not_ordered', 'ordered', 'delivered', 'in_tooling', 'installed'] as const;
export type HandsetStage = (typeof HANDSET_STAGES)[number];

/** The stages a person can set (a model with nothing recorded is "not ordered"). */
export const HANDSET_SET_STAGES = ['ordered', 'delivered', 'in_tooling', 'installed'] as const;

export const HANDSET_STAGE_LABELS: Record<HandsetStage, string> = {
  not_ordered: 'Not ordered yet',
  ordered: 'Ordered',
  delivered: 'Delivered',
  in_tooling: 'Added to tooling & updated',
  installed: 'Installed & working',
};

/** "Poly CCX 400" and " poly  ccx 400 " are the same model. */
export function handsetModelKey(model: string | null | undefined): string {
  return (model ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface HandsetModelRow {
  key: string;
  /** the model as most often typed in Data Collection */
  model: string;
  users: number;
  caps: number;
  total: number;
  status: HandsetStage;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface SiteHandsets {
  models: HandsetModelRow[];
  /** users marked "requires a handset" with no model recorded - they cannot be counted until a model is entered */
  usersWithoutModel: number;
  totals: Record<HandsetStage, number>;
}

/** Groups the models typed against users and common area phones into one row per model, with how many of each and where it has got to. */
export function summariseHandsets(
  userModels: (string | null)[],
  capModels: (string | null)[],
  tracking: { model_key: string; status: string; updated_by: string | null; updated_at: string | Date | null }[],
  usersWithoutModel = 0,
): SiteHandsets {
  const byKey = new Map<string, { spellings: Map<string, number>; users: number; caps: number }>();
  const add = (raw: string | null, kind: 'users' | 'caps') => {
    const key = handsetModelKey(raw);
    if (!key) return;
    const entry = byKey.get(key) ?? { spellings: new Map<string, number>(), users: 0, caps: 0 };
    const spelling = (raw ?? '').trim().replace(/\s+/g, ' ');
    entry.spellings.set(spelling, (entry.spellings.get(spelling) ?? 0) + 1);
    entry[kind] += 1;
    byKey.set(key, entry);
  };
  for (const m of userModels) add(m, 'users');
  for (const m of capModels) add(m, 'caps');

  const track = new Map(tracking.map((t) => [t.model_key, t]));
  const models: HandsetModelRow[] = [...byKey.entries()]
    .map(([key, e]) => {
      const t = track.get(key);
      const status = (HANDSET_SET_STAGES as readonly string[]).includes(t?.status ?? '') ? (t!.status as HandsetStage) : 'not_ordered';
      const model = [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
      return {
        key,
        model,
        users: e.users,
        caps: e.caps,
        total: e.users + e.caps,
        status,
        updatedBy: t?.updated_by ?? null,
        updatedAt: t?.updated_at ? new Date(t.updated_at).toISOString() : null,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));

  const totals: Record<HandsetStage, number> = { not_ordered: 0, ordered: 0, delivered: 0, in_tooling: 0, installed: 0 };
  for (const m of models) totals[m.status] += m.total;
  return { models, usersWithoutModel, totals };
}
