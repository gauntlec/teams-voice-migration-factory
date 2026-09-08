import type { ColumnType, Generated } from 'kysely';

/** jsonb column: read as T, write as T. */
export type Json<T = unknown> = ColumnType<T, T, T>;
type Ts = ColumnType<string, string | undefined, string>;

/* ----------------------------- platform schema ---------------------------- */

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  schema_name: string;
  primary_domain: string | null;
  status: ColumnType<'active' | 'archived', 'active' | 'archived' | undefined, 'active' | 'archived'>;
  created_by: string | null;
  created_at: Ts;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'SUPER_ADMIN' | 'PROJECT_MANAGER' | 'ENGINEER' | 'CUSTOMER';
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled'>;
  totp_enrolled: ColumnType<boolean, boolean | undefined, boolean>;
  failed_logins: ColumnType<number, number | undefined, number>;
  locked_until: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface TenantMembershipsTable {
  user_id: string;
  tenant_id: string;
  added_by: string | null;
  /** empty = whole customer; otherwise the discovery_sites.id values this member is limited to */
  site_ids: ColumnType<string[], string[] | undefined, string[]>;
  created_at: Ts;
}

export interface TotpSecretsTable {
  user_id: string;
  secret_enc: string;
  confirmed_at: string | null;
  created_at: Ts;
}

export interface AuthSessionsTable {
  id: Generated<string>;
  user_id: string;
  refresh_hash: string;
  family_id: string;
  user_agent: string | null;
  ip: string | null;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
  created_at: Ts;
}

export interface InvitationsTable {
  id: Generated<string>;
  email: string;
  role: 'SUPER_ADMIN' | 'PROJECT_MANAGER' | 'ENGINEER' | 'CUSTOMER';
  tenant_id: string | null;
  token_hash: string;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: Ts;
}

export interface PlatformAuditLogTable {
  id: Generated<string>;
  at: Ts;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  tenant_id: string | null;
  detail: Json;
  ip: string | null;
}

/* ------------------------- tenant_<shortid> schema ----------------------- */

export interface DiscoveryTable {
  id: Generated<string>;
  status: ColumnType<'draft' | 'submitted' | 'accepted', 'draft' | 'submitted' | 'accepted' | undefined, 'draft' | 'submitted' | 'accepted'>;
  general: Json<import('@tvmf/shared').DiscoveryGeneral>;
  submitted_by: string | null;
  submitted_at: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface DiscoveryFlowsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  kind: 'auto_attendant' | 'call_queue' | 'other';
  name: string;
  description: string | null;
  diagram_attachment_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface DiscoverySitesTable {
  id: Generated<string>;
  /** Unique key for the site; DID ranges link to it by this value. */
  sitecode: string;
  name: string | null;
  address: string | null;
  country: string | null;
  region: string | null;
  /** WGS84 coordinates for the site map; null until placed. */
  latitude: number | null;
  longitude: number | null;
  paging: Json;
  created_at: Ts;
}

export interface DiscoveryNumberRangesTable {
  id: Generated<string>;
  range_start: string;
  range_end: string;
  kind: 'new' | 'port' | 'retain';
  carrier: string | null;
  port_status: string | null;
  /** FK -> discovery_sites.sitecode (ON UPDATE CASCADE, ON DELETE SET NULL). */
  sitecode: string | null;
  loa_sent: ColumnType<boolean, boolean | undefined, boolean>;
  loa_completed: ColumnType<boolean, boolean | undefined, boolean>;
  comments: string | null;
  created_at: Ts;
}

export interface DiscoveryCallingPoliciesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  allow_local: ColumnType<boolean, boolean | undefined, boolean>;
  allow_national: ColumnType<boolean, boolean | undefined, boolean>;
  allow_international: ColumnType<boolean, boolean | undefined, boolean>;
  allow_service: ColumnType<boolean, boolean | undefined, boolean>;
  allow_premium: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
  updated_at: Ts;
}

export interface PhoneNumbersTable {
  id: Generated<string>;
  range_id: string;
  e164: string;
  status: ColumnType<'available' | 'reserved' | 'assigned', 'available' | 'reserved' | 'assigned' | undefined, 'available' | 'reserved' | 'assigned'>;
  holder_type: 'user' | 'cap' | 'resource_account' | 'analogue' | null;
  holder_id: string | null;
  note: string | null;
  created_at: Ts;
}

export interface DiscoveryUsersTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  upn: string;
  display_name: string | null;
  calling_policy_id: string | null;
  caller_id: 'user' | 'anonymous' | 'main_number' | null;
  voicemail_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  voicemail_language: string | null;
  requires_handset: ColumnType<boolean, boolean | undefined, boolean>;
  handset_model: string | null;
  access_port_id: string | null;
  comments: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface DiscoveryCapsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  display_name: string;
  upn: string | null;
  device_model: string | null;
  calling_policy_id: string | null;
  caller_id: 'user' | 'anonymous' | 'main_number' | null;
  access_port_id: string | null;
  comments: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface DiscoveryResourceAccountsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  name: string;
  kind: 'auto_attendant' | 'call_queue';
  directory_entry: string | null;
  business_hours: string | null;
  who_answers: string | null;
  ooh_action: string | null;
  exception_conditions: string | null;
  exception_action: string | null;
  holiday: string | null;
  advanced_features: string | null;
  comments: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface DiscoveryNetworkTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  scope: 'internal' | 'external';
  subnet: string;
  mask: number | null;
  location: string | null;
  network_type: 'LAN' | 'WLAN' | null;
  created_at: Ts;
}

export interface AttachmentsTable {
  id: Generated<string>;
  filename: string;
  content_type: string;
  bytes: Buffer;
  uploaded_by: string | null;
  created_at: Ts;
}

export interface BuildUsersTable {
  id: Generated<string>;
  upn: string;
  did: string | null;
  ext: string | null;
  e164: string | null;
  number_type: string | null;
  revoke_ev: ColumnType<boolean, boolean | undefined, boolean>;
  hold_uri: string | null;
  action: string | null;
  migration_wave: string | null;
  /** policy assignments keyed by PolicyKey from @tvmf/shared */
  policies: Json<Record<string, string | null>>;
  voicemail: Json;
  call_forwarding: Json;
  delegates: Json;
  pickup_group: Json;
  comments: string | null;
  /** results of validating this row against the live tenant */
  validation: Json;
  /** requested/completed dates + applied flags */
  status: Json;
  errors: string | null;
  hidden: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildCapsTable extends BuildUsersTable {
  function: string | null;
  display_name: string | null;
  phone_model: string | null;
  device_config_profile: string | null;
  mac_address: string | null;
  serial_number: string | null;
  phone_location: string | null;
  lan_jack: string | null;
}

export interface BuildResourceAccountsTable {
  id: Generated<string>;
  upn: string;
  display_name: string | null;
  kind: 'auto_attendant' | 'call_queue';
  location_id: string | null;
  phone_number: string | null;
  number_type: string | null;
  application_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildAutoAttendantsTable {
  id: Generated<string>;
  name: string;
  resource_accounts: Json;
  language: string | null;
  timezone: string | null;
  config: Json;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildCallQueuesTable {
  id: Generated<string>;
  name: string;
  resource_accounts: Json;
  config: Json;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildM365GroupsTable {
  id: Generated<string>;
  name: string;
  email: string | null;
  description: string | null;
  used_for_voicemail: ColumnType<boolean, boolean | undefined, boolean>;
  owners: Json;
  members: Json;
  group_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface ConnectionsTable {
  id: Generated<string>;
  started_by: string;
  method: ColumnType<'device_code', 'device_code' | undefined, 'device_code'>;
  status: 'pending' | 'active' | 'expired' | 'closed';
  user_code: string | null;
  verification_uri: string | null;
  tenant_domain: string | null;
  upn: string | null;
  scopes: string | null;
  started_at: Ts;
  expires_at: string | null;
  closed_at: string | null;
  /* deliberately NO token columns - see docs/SECURITY.md */
}

export interface DeploymentsTable {
  id: Generated<string>;
  connection_id: string | null;
  mode: 'dry_run' | 'execute';
  scope: Json;
  status: ColumnType<'queued' | 'running' | 'completed' | 'failed' | 'cancelled', 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined, 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>;
  created_by: string;
  started_at: string | null;
  finished_at: string | null;
  summary: Json;
  created_at: Ts;
}

export interface DeploymentChangesTable {
  id: Generated<string>;
  deployment_id: string;
  seq: number;
  at: Ts;
  operator_user_id: string | null;
  correlation_id: string;
  object_type: string;
  object_id: string | null;
  cmdlet: string;
  parameters: Json;
  before: Json;
  after: Json;
  result: 'applied' | 'skipped' | 'failed' | 'whatif';
  message: string | null;
}

export interface DeploymentScriptsTable {
  id: Generated<string>;
  deployment_id: string;
  filename: string;
  kind: 'ps1' | 'txt';
  content: string;
  created_at: Ts;
}

export interface HandoverPacksTable {
  id: Generated<string>;
  version: number;
  status: ColumnType<'draft' | 'issued', 'draft' | 'issued' | undefined, 'draft' | 'issued'>;
  generated_by: string;
  generated_at: string | null;
  source: Json;
  file: Buffer | null;
  created_at: Ts;
}

export interface HandoverSectionsTable {
  id: Generated<string>;
  pack_id: string;
  key: string;
  title: string;
  ordinal: number;
  content: Json;
}

export interface TenantAuditLogTable {
  id: Generated<string>;
  at: Ts;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Json;
}

/* ------------------------------ merged DB ------------------------------- */
/**
 * One Kysely<DB>. Platform tables are queried with `.withSchema('platform')`,
 * tenant tables with `.withSchema(tenantSchemaName)` — never unqualified.
 */
export interface DB {
  // platform
  tenants: TenantsTable;
  users: UsersTable;
  tenant_memberships: TenantMembershipsTable;
  totp_secrets: TotpSecretsTable;
  auth_sessions: AuthSessionsTable;
  invitations: InvitationsTable;
  platform_audit_log: PlatformAuditLogTable;
  // tenant
  discovery: DiscoveryTable;
  discovery_sites: DiscoverySitesTable;
  discovery_number_ranges: DiscoveryNumberRangesTable;
  discovery_network: DiscoveryNetworkTable;
  discovery_flows: DiscoveryFlowsTable;
  discovery_calling_policies: DiscoveryCallingPoliciesTable;
  phone_numbers: PhoneNumbersTable;
  discovery_users: DiscoveryUsersTable;
  discovery_caps: DiscoveryCapsTable;
  discovery_resource_accounts: DiscoveryResourceAccountsTable;
  attachments: AttachmentsTable;
  build_users: BuildUsersTable;
  build_caps: BuildCapsTable;
  build_resource_accounts: BuildResourceAccountsTable;
  build_auto_attendants: BuildAutoAttendantsTable;
  build_call_queues: BuildCallQueuesTable;
  build_m365_groups: BuildM365GroupsTable;
  connections: ConnectionsTable;
  deployments: DeploymentsTable;
  deployment_changes: DeploymentChangesTable;
  deployment_scripts: DeploymentScriptsTable;
  handover_packs: HandoverPacksTable;
  handover_sections: HandoverSectionsTable;
  audit_log: TenantAuditLogTable;
}

export const PLATFORM_SCHEMA = 'platform';
