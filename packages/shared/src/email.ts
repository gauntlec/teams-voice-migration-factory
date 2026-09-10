/**
 * Contracts for the email communication module. The API enqueues a message by
 * `template` + `context`; the worker owns rendering (branded HTML) and delivery.
 * Add a new kind of email by adding a name here and a renderer in
 * `apps/worker/src/mail/templates.ts`.
 */

export const EMAIL_TEMPLATES = ['user_invitation', 'discovery_completed'] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export const EMAIL_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Context for the `user_invitation` template. */
export interface UserInvitationContext {
  displayName: string;
  /** email of the admin/engineer who created the account */
  inviterEmail: string;
  role: string;
  /** customer names the user was granted access to (may be empty) */
  tenantNames: string[];
  /** one-time password the recipient signs in with */
  tempPassword: string;
  /** absolute URL of the web app sign-in page */
  signInUrl: string;
}

/** Context for the `discovery_completed` template (sent by the worker when a
 * tenant-discovery run reaches a terminal state). */
export interface DiscoveryCompletedContext {
  /** display name of the person who started the run */
  recipientName: string;
  /** customer / tenant name */
  customerName: string;
  outcome: 'completed' | 'completed_with_errors' | 'failed';
  /** "Full discovery" or "Partial: users, policies" */
  scopeLabel: string;
  /** human duration, e.g. "4 min 12 s" */
  durationText: string;
  /** objects in the snapshot after this run */
  totalObjects: number;
  added: number;
  updated: number;
  removed: number;
  readded: number;
  /** User accounts left out because they are not licensed for Teams */
  skippedNotLicensed: number;
  /** non-fatal step errors */
  errorCount: number;
  /** set when the run could not read licence data and skipped the user filter */
  filterNote?: string | null;
  /** set when the run failed / lost the sign-in */
  errorMessage?: string | null;
  /** biggest object types this run stored, for a quick breakdown */
  breakdown: { label: string; count: number }[];
  /** absolute URL of the Discovery page */
  runUrl: string;
}

/** Loose map used at the enqueue/render boundary. */
export type EmailContext = Record<string, unknown>;
