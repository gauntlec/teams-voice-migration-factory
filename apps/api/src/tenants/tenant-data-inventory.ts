/**
 * Everything in the shared (platform) database that points at one customer, and what deleting the customer does with it.
 *
 * This list is checked against the real database by tests/db/src/tenants/tenant-deletion.db.test.ts: the test reads every
 * foreign key and every customer-looking column from information_schema and FAILS when a table or column exists that is not
 * listed here (or is listed here and does not exist). So when someone adds a table that refers to a customer, the build tells
 * them to decide how the deletion handles it, and it cannot be forgotten.
 *
 * Handling:
 *  - `cascade`        removed by the database itself when the customer row is deleted (ON DELETE CASCADE).
 *  - `deleted`        TenantDeletionService deletes these rows on purpose (the foreign key only clears the link, or there is none).
 *  - `scrubbed`       the row stays, the customer's name is removed from it.
 *  - `kept`           stays by design (the platform audit log). docs/SECURITY.md says so plainly.
 *  - `not_customer`   the name only looks like a customer reference.
 *
 * What lives INSIDE the customer's own schema (tenant_<id>) needs no entry: the whole schema is dropped.
 */
export type TenantDataHandling = 'cascade' | 'deleted' | 'scrubbed' | 'kept' | 'not_customer';

export interface TenantDataEntry {
  table: string;
  column: string;
  handling: TenantDataHandling;
  note: string;
}

export const PLATFORM_TENANT_REFERENCES: readonly TenantDataEntry[] = [
  { table: 'tenant_memberships', column: 'tenant_id', handling: 'cascade', note: 'Who belongs to the customer. Customer-only people are deleted as well (see TenantDeletionService.customerOnlyUsers).' },
  { table: 'agent_customer_policy', column: 'tenant_id', handling: 'cascade', note: 'What each assistant may do at this customer.' },
  { table: 'agent_events', column: 'tenant_id', handling: 'cascade', note: 'The assistants\' events feed for this customer.' },
  { table: 'inbound_reply_tokens', column: 'tenant_id', handling: 'cascade', note: 'Reply-by-email tokens for the customer\'s incidents.' },
  { table: 'intake_sources', column: 'tenant_id', handling: 'cascade', note: 'Monitoring alert sources for the customer.' },
  { table: 'invitations', column: 'tenant_id', handling: 'cascade', note: 'Unaccepted invitations to the customer. Invitations to the deleted people\'s addresses are deleted too.' },
  { table: 'email_messages', column: 'tenant_id', handling: 'deleted', note: 'The email log: every message about the customer, and every message sent to a person who is deleted with it.' },
  { table: 'inbound_email_log', column: 'tenant_id', handling: 'deleted', note: 'Incoming email that became (or was refused for) an incident of the customer, and mail from the deleted people.' },
  { table: 'msp_notifications', column: 'tenant_id', handling: 'deleted', note: 'Queued or sent Teams-channel notes about the customer\'s incidents.' },
  { table: 'bug_reports', column: 'affected_customer', handling: 'scrubbed', note: 'The "affected customer" field is emptied when it holds exactly this customer\'s name. Free text elsewhere in a report is not searched.' },
  { table: 'platform_audit_log', column: 'tenant_id', handling: 'kept', note: 'Append-only by design. Keeps who did what to the customer, with its id (and the name in the deletion entry), but no customer content.' },
  { table: 'sso_providers', column: 'role_ceiling_customer', handling: 'not_customer', note: 'The highest role a provider may give to its customer-type accounts. Not a customer.' },
];

/**
 * Foreign keys to platform.users that do NOT clean up by themselves when a person is deleted (ON DELETE NO ACTION or RESTRICT).
 * Deleting a person fails unless the code removes these rows first. Checked by the same test.
 */
export const USER_REFERENCES_NEEDING_CODE: readonly { table: string; column: string; note: string }[] = [
  { table: 'invitations', column: 'invited_by', note: 'Invitations a person raised are deleted before the person (same as deleting a user on the Users page).' },
];
