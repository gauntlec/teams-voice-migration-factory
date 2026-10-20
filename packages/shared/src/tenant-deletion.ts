import { z } from 'zod';

/**
 * Deleting a customer for good (docs/SECURITY.md "Deleting a customer"). Shared by the API and the Customers page so the words
 * and the numbers can never disagree.
 */

/** What a Super Admin sends to confirm: the customer's exact name, and the current code from their authenticator app. */
export const deleteTenantSchema = z
  .object({
    confirmName: z.string().min(1).max(200),
    totpCode: z.string().regex(/^\d{6}$/, 'The code is 6 digits'),
  })
  .strict();
export type DeleteTenantInput = z.infer<typeof deleteTenantSchema>;

/** Numbers only, never customer content. */
export interface TenantDeletionCounts {
  sites: number;
  /** Customer-only sign-ins that will be deleted with the customer. */
  usersDeleted: number;
  /** People who also belong elsewhere, or who are staff: they only lose access to this customer. */
  usersLoseAccess: number;
  files: number;
  fileBytes: number;
  incidents: number;
  serviceRequests: number;
  /** Discovery runs (each one holds a snapshot of the customer's Microsoft Teams set-up). */
  discoveryRuns: number;
  deployments: number;
  numberPorts: number;
  /** Rows in the email log that are about this customer or sent to the people being deleted. */
  emailRecords: number;
}

export type TenantDeletionBlockerKind = 'deployment' | 'discovery';

/** Work that cannot be cut off safely. While any exists the deletion is refused. */
export interface TenantDeletionBlocker {
  kind: TenantDeletionBlockerKind;
  count: number;
  /** Plain sentence for the person, saying what to do. */
  message: string;
}

export interface TenantDeletionSummary {
  tenant: { id: string; name: string; status: string };
  counts: TenantDeletionCounts;
  /** Teams sign-ins that are open right now. They are closed as part of the deletion. */
  openSessions: number;
  blockers: TenantDeletionBlocker[];
  /** True when an earlier attempt stopped part way: the counts are the ones saved when it started. */
  unfinished: boolean;
}

export function blockerMessage(kind: TenantDeletionBlockerKind, count: number): string {
  if (kind === 'deployment') {
    return count === 1
      ? 'A deployment for this customer is running or waiting to run. Wait for it to finish (see Deployment), then try again.'
      : `${count} deployments for this customer are running or waiting to run. Wait for them to finish (see Deployment), then try again.`;
  }
  return count === 1
    ? 'A Discovery run for this customer is running or waiting to run. Wait for it to finish (see Discovery), then try again.'
    : `${count} Discovery runs for this customer are running or waiting to run. Wait for them to finish (see Discovery), then try again.`;
}

/** The kinds of problem the delete route reports in `code`, so the page can react without reading the words. */
export const TENANT_DELETE_ERROR_CODES = ['name_mismatch', 'mfa_incorrect', 'mfa_not_set_up', 'busy', 'worker_unavailable', 'still_finishing'] as const;
export type TenantDeleteErrorCode = (typeof TENANT_DELETE_ERROR_CODES)[number];

/** What the delete route answers when it is done. */
export interface TenantDeletionResult {
  deleted: true;
  counts: TenantDeletionCounts;
}
