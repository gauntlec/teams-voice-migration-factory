/**
 * Contracts for the email communication module. The API enqueues a message by
 * `template` + `context`; the worker owns rendering (branded HTML) and delivery.
 * Add a new kind of email by adding a name here and a renderer in
 * `apps/worker/src/mail/templates.ts`.
 */

export const EMAIL_TEMPLATES = ['user_invitation'] as const;
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

/** Loose map used at the enqueue/render boundary. */
export type EmailContext = Record<string, unknown>;
