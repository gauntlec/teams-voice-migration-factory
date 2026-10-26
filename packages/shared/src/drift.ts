/*
 * Drift: a Design & Build row that was deployed, has not been edited since, and no longer matches what Teams has.
 * Someone changed it outside Voxshift (Teams Admin Center, PowerShell). A row edited after its last deployment is a
 * pending design change instead, and a row never deployed is just a design - neither is drift.
 * The plan is worked out from Discovery's stored live state, so drift is only as fresh as the last sync.
 */

/** `drift`: live changed after the deployment. `awaiting_sync`: deployed, but no sync has read the tenant since. */
export type DriftState = 'drift' | 'awaiting_sync';

/** One row's latest live run, from its deployment_changes rows. */
export interface RowDeploymentHistory {
  /** When the row's latest live run with at least one applied command and no failed one last touched it. */
  lastCleanAt: string | null;
  /** True when a later live run failed for the row - the design never fully landed, so the gap is not drift. */
  failedSince: boolean;
}

export interface DriftInputs {
  /** The row plans at least one command against the live state. */
  planned: boolean;
  history: RowDeploymentHistory | undefined;
  /** build_*.updated_at */
  rowUpdatedAt: string;
  /** finished_at of the latest completed Discovery sync, null if never */
  lastSyncAt: string | null;
}

export function classifyDrift(i: DriftInputs): DriftState | null {
  if (!i.planned || !i.history?.lastCleanAt || i.history.failedSince) return null;
  const deployed = Date.parse(i.history.lastCleanAt);
  if (Date.parse(i.rowUpdatedAt) > deployed) return null;
  if (!i.lastSyncAt || Date.parse(i.lastSyncAt) <= deployed) return 'awaiting_sync';
  return 'drift';
}

/** A drifted row as stored after a sync and shown on the Drift view. */
export interface DriftRow {
  rowId: string;
  objectType: 'user' | 'cap' | 'resource_account' | 'call_queue' | 'auto_attendant' | 'shared_calling_policy';
  name: string;
  state: DriftState;
  /** The cmdlets that would put it back, e.g. Set-CsCallQueue - what differs, in Teams' own words. */
  cmdlets: string[];
  lastDeployedAt: string;
}

export interface SiteDriftSummary {
  siteId: string;
  drifted: number;
  awaitingSync: number;
  computedAt: string;
  rows: DriftRow[];
}

/**
 * The commands that show a real difference from live. A user's voicemail and calling-settings commands are planned whenever
 * Discovery has not read those settings yet (the planner cannot tell, so it always re-sends them) - no evidence that anyone
 * changed anything in Teams, so they do not count towards drift.
 */
export function driftEvidence(cmdlets: string[], known: { voicemail: boolean; callingSettings: boolean }): string[] {
  return [...new Set(cmdlets)].filter((c) => {
    if (c === 'Set-CsOnlineVoicemailUserSettings') return known.voicemail;
    if (c === 'Set-CsUserCallingSettings' || c === 'New-CsUserCallingDelegate') return known.callingSettings;
    return true;
  });
}

/** What "Accept into design" can take from live for each kind of row; the rest is put back, or edited in Design & Build. */
export const DRIFT_ACCEPTABLE: Record<DriftRow['objectType'], boolean> = {
  user: true,
  cap: true,
  auto_attendant: true,
  call_queue: true,
  resource_account: false,
  shared_calling_policy: false,
};

/** Cmdlets that "Accept into design" covers for a user or common area phone (calling settings and voicemail). */
const IDENTITY_ACCEPTABLE_CMDLETS = new Set([
  'Set-CsUserCallingSettings',
  'New-CsUserCallingDelegate',
  'Set-CsUserCallingDelegate',
  'Remove-CsUserCallingDelegate',
  'Set-CsOnlineVoicemailUserSettings',
]);

/** The cmdlets of a drifted user or common area phone that Accept into design does not cover (number, Enterprise Voice, policies). */
export function identityDriftNotAccepted(cmdlets: string[]): string[] {
  return [...new Set(cmdlets.filter((c) => !IDENTITY_ACCEPTABLE_CMDLETS.has(c)))];
}
