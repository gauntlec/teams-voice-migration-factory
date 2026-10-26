import type { DeploymentPreviewRow } from './index';

export type DeploymentGroupBy = 'type' | 'wave';
export const NO_WAVE = 'No wave';

/** Wave names in a human order (Wave 2 before Wave 10); the rows with no wave come last. */
export const compareWaves = (a: string, b: string) => (a === NO_WAVE ? (b === NO_WAVE ? 0 : 1) : b === NO_WAVE ? -1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

/**
 * The groups the Planned changes table shows. By type: each object type in deployment order. By wave: each migration wave in name
 * order, then "No wave" (everything that is not a user or common area phone, and any not given a wave yet); inside a wave the rows keep
 * the deployment order of their type.
 */
export function groupDeploymentRows(
  rows: DeploymentPreviewRow[],
  groupBy: DeploymentGroupBy,
  typeOrder: DeploymentPreviewRow['objectType'][],
  typeLabel: Record<DeploymentPreviewRow['objectType'], string>,
): { key: string; label: string; rows: DeploymentPreviewRow[] }[] {
  if (groupBy === 'type') {
    return typeOrder.map((type) => ({ key: type, label: typeLabel[type], rows: rows.filter((r) => r.objectType === type) })).filter((g) => g.rows.length > 0);
  }
  const waveOf = (r: DeploymentPreviewRow) => r.wave?.trim() || NO_WAVE;
  return [...new Set(rows.map(waveOf))].sort(compareWaves).map((wave) => ({
    key: wave,
    label: wave,
    rows: typeOrder.flatMap((type) => rows.filter((r) => r.objectType === type && waveOf(r) === wave)),
  }));
}
