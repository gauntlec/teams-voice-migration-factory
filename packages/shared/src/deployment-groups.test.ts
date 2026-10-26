import { describe, expect, it } from 'vitest';
import { groupDeploymentRows } from './deployment-groups';
import type { DeploymentPreviewRow } from './index';

const row = (rowId: string, objectType: DeploymentPreviewRow['objectType'], wave?: string | null): DeploymentPreviewRow => ({ rowId, objectType, upn: rowId, calls: [], renderedCommands: [], warnings: [], wave });
const ORDER: DeploymentPreviewRow['objectType'][] = ['user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant'];
const LABEL = { user: 'User', cap: 'Common Area Phone', resource_account: 'Resource Account', shared_calling_policy: 'Shared Calling Policy', call_queue: 'Call Queue', auto_attendant: 'Auto Attendant' };

describe('grouping the planned changes', () => {
  const rows = [row('aa', 'auto_attendant'), row('u10', 'user', 'Wave 10'), row('u2', 'user', 'Wave 2'), row('c2', 'cap', 'Wave 2'), row('u0', 'user'), row('ra', 'resource_account', '  ')];

  it('by object type keeps the deployment order and drops empty types', () => {
    expect(groupDeploymentRows(rows, 'type', ORDER, LABEL).map((g) => [g.label, g.rows.length])).toEqual([['User', 3], ['Common Area Phone', 1], ['Resource Account', 1], ['Auto Attendant', 1]]);
  });

  it('by wave sorts the waves naturally, puts "No wave" last, and keeps the type order inside a wave', () => {
    const g = groupDeploymentRows(rows, 'wave', ORDER, LABEL);
    expect(g.map((x) => x.label)).toEqual(['Wave 2', 'Wave 10', 'No wave']);
    expect(g[0]!.rows.map((r) => r.rowId)).toEqual(['u2', 'c2']);
    expect(g[2]!.rows.map((r) => r.rowId)).toEqual(['u0', 'ra', 'aa']);
  });
});
