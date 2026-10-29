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
  /** 'deleting' = being erased for good (0036): hidden everywhere, nobody can open it, background work skips it. */
  status: ColumnType<'active' | 'archived' | 'deleting', 'active' | 'archived' | 'deleting' | undefined, 'active' | 'archived' | 'deleting'>;
  /** When true, the platform must never send a write cmdlet to this customer's live Microsoft Teams tenant - see 0006_tenant_teams_read_only.sql. */
  teams_read_only: ColumnType<boolean, boolean | undefined, boolean>;
  /** null = default Voxshift branding everywhere (web theme, Logo, emails) - see 0008_tenant_branding.sql. */
  branding: Json<import('@tvmf/shared').Branding> | null;
  /** Managed Services switched on: this customer can raise service requests - see 0012_tenant_managed_services.sql. */
  managed_services_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Monitoring (Devices / Watch list / Alerts) switched on for this customer; on by default - see 0038_tenant_monitoring.sql. */
  monitoring_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Managed Services settings: targets, approvals, change window - see 0014_tenant_sr_settings.sql. Written as JSON.stringify(...). */
  sr_settings: ColumnType<import('@tvmf/shared').SrSettings, string | undefined, string>;
  /** Incident targets and impact x urgency matrix - see 0016_tenant_inc_settings.sql. Written as JSON.stringify(...). */
  inc_settings: ColumnType<import('@tvmf/shared').IncSettings, string | undefined, string>;
  /** Kill switch for every agent on this customer - see 0017_agents.sql. */
  agents_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** The MSP that looks after this customer - see 0013_tenant_msp.sql. */
  msp_id: string | null;
  /** A test customer: its emails go to whoever triggered them - see 0015_release_safety.sql. */
  sandbox: ColumnType<boolean, boolean | undefined, boolean>;
  /** Test customer's fallback address for emails nobody triggered; null = those are skipped. */
  sandbox_email: string | null;
  created_by: string | null;
  created_at: Ts;
  /** Set when a Super Admin started deleting this customer - see 0036_tenant_deleting.sql. */
  deletion_started_at: ColumnType<string | null, string | null | undefined, string | null>;
  deletion_started_by: ColumnType<string | null, string | null | undefined, string | null>;
  /** Counts shown before the deletion was confirmed (numbers only), kept so a retry can still report them. */
  deletion_summary: ColumnType<Record<string, number> | null, string | null | undefined, string | null>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'SUPER_ADMIN' | 'PROJECT_MANAGER' | 'ENGINEER' | 'CUSTOMER';
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined, 'active' | 'disabled'>;
  totp_enrolled: ColumnType<boolean, boolean | undefined, boolean>;
  /** true until the user completes the forced reset on first sign-in */
  must_change_password: ColumnType<boolean, boolean | undefined, boolean>;
  password_changed_at: string | null;
  failed_logins: ColumnType<number, number | undefined, number>;
  locked_until: string | null;
  /** Explicit MSP-branding override for ENGINEER/PROJECT_MANAGER, used only when no domain matches - see 0009_msps.sql. */
  msp_id: string | null;
  /** A locally created Super Admin who keeps password + authenticator sign-in even when local passwords are switched off - see 0031_sso.sql. */
  break_glass: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
  updated_at: Ts;
}

/**
 * A Managed Service Provider - see 0009_msps.sql. `domains` drives
 * automatic branding resolution for ENGINEER/PROJECT_MANAGER users whose
 * account email matches one of them (packages/shared's Msp type mirrors
 * this shape for API responses).
 */
export interface MspsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  domains: ColumnType<string[], string[] | undefined, string[]>;
  branding: Json<import('@tvmf/shared').Branding> | null;
  created_by: string | null;
  created_at: Ts;
  /** 0023_msp_teams_notify.sql - the Teams Workflows webhook (encrypted) and what to tell the channel about. */
  teams_webhook_enc: ColumnType<string | null, string | null | undefined, string | null>;
  teams_notify: ColumnType<import('@tvmf/shared').MspNotifyConfig, string | undefined, string>;
}

export interface EmailMessagesTable {
  id: Generated<string>;
  to_email: string;
  to_name: string | null;
  template: string;
  context: Json;
  subject: string | null;
  status: ColumnType<
    'queued' | 'sent' | 'failed' | 'skipped',
    'queued' | 'sent' | 'failed' | 'skipped' | undefined,
    'queued' | 'sent' | 'failed' | 'skipped'
  >;
  error: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  related_type: string | null;
  related_id: string | null;
  /** Which customer this email is for, when it's tenant-scoped - drives branding at render time. Null for cross-tenant/platform-level mail (feature/bug status). */
  tenant_id: string | null;
  /** Which MSP this email is for, when the recipient is MSP staff - drives branding at render time (see loadEmailBranding in apps/worker/src/main.ts). Mutually exclusive with tenant_id in practice. */
  msp_id: string | null;
  created_by: string | null;
  /** 0022_inbound_email.sql - the Reply-To an incident email carries, so a reply comes back to the incident. */
  reply_to: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  sent_at: string | null;
  /** Set when a test customer's email was redirected: who it was really for (to_email is where it went) - see 0015_release_safety.sql. */
  original_to_email: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Platform-wide settings (one row, id is always true) - see 0025_app_settings.sql. */
/** The monitoring module's administrator, one per installation (platform migration 0037). */
export interface MonitoringAdminTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  admin_user: string;
  admin_pass_enc: string;
  updated_at: ColumnType<string, string | undefined, string>;
}

export interface AppSettingsTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  /** The address people use to reach this installation; null = use the WEB_ORIGIN environment value. */
  base_url: string | null;
  /** Master email switch: false = no email is generated or sent - see 0026_email_switch.sql. */
  email_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** The Voxshift Hub this installation reports to (0027_hub_connection.sql); null = not connected. */
  hub_url: ColumnType<string | null, string | null | undefined, string | null>;
  /** The hub's instance token, encrypted with DATA_ENCRYPTION_KEY. */
  hub_token_enc: ColumnType<string | null, string | null | undefined, string | null>;
  hub_token_hint: ColumnType<string | null, string | null | undefined, string | null>;
  hub_last_attempt_at: ColumnType<string | null, string | null | undefined, string | null>;
  hub_last_ok_at: ColumnType<string | null, string | null | undefined, string | null>;
  hub_last_error: ColumnType<string | null, string | null | undefined, string | null>;
  /** The customer's switch: may staff open this installation through the hub? (0028_hub_remote_access.sql) */
  hub_remote_access: ColumnType<boolean, boolean | undefined, boolean>;
  hub_tunnel_state: ColumnType<'off' | 'connecting' | 'connected' | 'error', 'off' | 'connecting' | 'connected' | 'error' | undefined, 'off' | 'connecting' | 'connected' | 'error'>;
  hub_tunnel_error: ColumnType<string | null, string | null | undefined, string | null>;
  hub_tunnel_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** Email settings kept in the app (0029_mail_settings.sql). mail_mode null = use the SMTP_* environment values. */
  mail_mode: ColumnType<'none' | 'smtp' | 'hub' | null, 'none' | 'smtp' | 'hub' | null | undefined, 'none' | 'smtp' | 'hub' | null>;
  smtp_host: ColumnType<string | null, string | null | undefined, string | null>;
  smtp_port: ColumnType<number | null, number | null | undefined, number | null>;
  smtp_secure: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  smtp_user: ColumnType<string | null, string | null | undefined, string | null>;
  /** The SMTP password, encrypted with DATA_ENCRYPTION_KEY. Never returned by the API. */
  smtp_pass_enc: ColumnType<string | null, string | null | undefined, string | null>;
  mail_from: ColumnType<string | null, string | null | undefined, string | null>;
  mail_from_name: ColumnType<string | null, string | null | undefined, string | null>;
  hub_mail_relay: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** The highest revocation line from the hub that has been applied (0032_sso_revocation.sql); bigint, so it comes back as a string. */
  hub_sso_revocation_ack: ColumnType<string, string | number | undefined, string | number>;
  /** Optional areas switched off for this installation (0030_disabled_features.sql). Empty = all on. */
  disabled_features: ColumnType<string[], string[] | undefined, string[]>;
  /** How long a federated (single sign-on) session lasts before the person signs in at the provider again, in hours (0031_sso.sql). */
  sso_session_max_hours: ColumnType<number, number | undefined, number>;
  /** Email the administrators when someone signs in as Super Admin through a provider (0031_sso.sql). */
  sso_notify_admin_signin: ColumnType<boolean, boolean | undefined, boolean>;
  updated_by: string | null;
  updated_at: Ts;
}

/** The single maintenance notice (id is always true) - see 0015_release_safety.sql. */
export interface MaintenanceNoticeTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  message: string;
  starts_at: string;
  created_by: string | null;
  created_at: Ts;
}

export interface FeatureRequestsTable {
  id: Generated<string>;
  title: string;
  area: string;
  status: ColumnType<
    import('@tvmf/shared').FeatureStatus,
    import('@tvmf/shared').FeatureStatus | undefined,
    import('@tvmf/shared').FeatureStatus
  >;
  priority: ColumnType<
    import('@tvmf/shared').FeaturePriority,
    import('@tvmf/shared').FeaturePriority | undefined,
    import('@tvmf/shared').FeaturePriority
  >;
  problem: string;
  proposal: string;
  current_behavior: string | null;
  examples: string | null;
  acceptance: string | null;
  constraints: string | null;
  affected_roles: ColumnType<string[], string[] | undefined, string[]>;
  decision_note: string | null;
  submitted_by: string | null;
  created_at: Ts;
  updated_at: ColumnType<string, string | undefined, string>;
  status_changed_at: ColumnType<string, string | undefined, string>;
  status_changed_by: string | null;
}

export interface BugReportsTable {
  id: Generated<string>;
  title: string;
  area: string;
  status: ColumnType<
    import('@tvmf/shared').BugStatus,
    import('@tvmf/shared').BugStatus | undefined,
    import('@tvmf/shared').BugStatus
  >;
  severity: ColumnType<
    import('@tvmf/shared').BugSeverity,
    import('@tvmf/shared').BugSeverity | undefined,
    import('@tvmf/shared').BugSeverity
  >;
  steps_to_reproduce: string;
  expected_behavior: string;
  actual_behavior: string;
  affected_customer: string | null;
  environment: string | null;
  resolution_note: string | null;
  reported_by: string | null;
  created_at: Ts;
  updated_at: ColumnType<string, string | undefined, string>;
  status_changed_at: ColumnType<string, string | undefined, string>;
  status_changed_by: string | null;
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
  pending_secret_enc: string | null;
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
  /** Authentication methods the provider reported for a federated session (0031_sso.sql); empty for a local sign-in. */
  amr: ColumnType<string[], string[] | undefined, string[]>;
  /** The provider a federated session came from; null = local password sign-in. */
  idp: ColumnType<string | null, string | null | undefined, string | null>;
  /** A federated session ends here whatever refreshing does. */
  absolute_expires_at: ColumnType<string | null, string | null | undefined, string | null>;
}

type RoleName = 'SUPER_ADMIN' | 'PROJECT_MANAGER' | 'ENGINEER' | 'CUSTOMER';

/** An identity provider this installation can sign people in with (the Voxshift Hub, or the customer's own OpenID Connect provider) - see 0031_sso.sql and docs/SSO.md. */
export interface SsoProvidersTable {
  id: Generated<string>;
  kind: 'hub' | 'oidc';
  name: string;
  issuer: string;
  client_id: string;
  /** Encrypted with DATA_ENCRYPTION_KEY. Never returned by the API. */
  client_secret_enc: ColumnType<string | null, string | null | undefined, string | null>;
  scopes: ColumnType<string, string | undefined, string>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  jit_create: ColumnType<boolean, boolean | undefined, boolean>;
  require_mfa_claim: ColumnType<boolean, boolean | undefined, boolean>;
  role_ceiling: ColumnType<RoleName, RoleName | undefined, RoleName>;
  role_ceiling_staff: ColumnType<RoleName, RoleName | undefined, RoleName>;
  role_ceiling_customer: ColumnType<RoleName, RoleName | undefined, RoleName>;
  default_role: ColumnType<RoleName, RoleName | undefined, RoleName>;
  role_claim: ColumnType<string | null, string | null | undefined, string | null>;
  /** claim value -> role. Written as JSON.stringify(...). */
  role_map: ColumnType<Record<string, RoleName>, string | undefined, string>;
  email_domains: ColumnType<string[], string[] | undefined, string[]>;
  allow_local_passwords: ColumnType<boolean, boolean | undefined, boolean>;
  /** The hub provider only: may hub STAFF accounts sign in (allowed), wait for an administrator's approval (needs_approval) or not at all (off)? 0033_sso_staff_access.sql */
  staff_access: ColumnType<'allowed' | 'needs_approval' | 'off', 'allowed' | 'needs_approval' | 'off' | undefined, 'allowed' | 'needs_approval' | 'off'>;
  last_test_at: ColumnType<string | null, string | null | undefined, string | null>;
  last_test_ok: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  last_test_detail: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
}

/** Who a local user is at a provider (the provider's `sub`). Never matched by email - see 0031_sso.sql. */
export interface ExternalIdentitiesTable {
  id: Generated<string>;
  user_id: string;
  provider_id: string;
  subject: string;
  email: string | null;
  account_kind: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  last_login_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** Sign-ins through this identity that began before this moment are over, whatever access token they hold (0032_sso_revocation.sql). */
  revoked_before: ColumnType<string | null, string | null | undefined, string | null>;
  /** The end of the approved window for a hub staff account (0033_sso_staff_access.sql); null = no limit. */
  access_until: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A hub staff sign-in waiting for an administrator of this installation, and the window it is given (0033_sso_staff_access.sql). */
export interface SsoAccessRequestsTable {
  id: Generated<string>;
  provider_id: string;
  user_id: string;
  subject: string;
  email: string;
  display_name: string | null;
  requested_role: string;
  effective_role: string;
  amr: ColumnType<string[], string[] | undefined, string[]>;
  provider_session: string | null;
  ip: string | null;
  user_agent: string | null;
  return_to: ColumnType<string, string | undefined, string>;
  status: ColumnType<'pending' | 'approved' | 'denied' | 'expired' | 'ended' | 'cancelled', 'pending' | 'approved' | 'denied' | 'expired' | 'ended' | 'cancelled' | undefined, 'pending' | 'approved' | 'denied' | 'expired' | 'ended' | 'cancelled'>;
  wait_token_hash: string;
  requested_at: ColumnType<string, string | undefined, string>;
  request_expires_at: string;
  decided_by: ColumnType<string | null, string | null | undefined, string | null>;
  decided_at: ColumnType<string | null, string | null | undefined, string | null>;
  decision_note: ColumnType<string | null, string | null | undefined, string | null>;
  window_hours: ColumnType<number | null, number | null | undefined, number | null>;
  window_starts_at: ColumnType<string | null, string | null | undefined, string | null>;
  window_ends_at: ColumnType<string | null, string | null | undefined, string | null>;
  claimed_at: ColumnType<string | null, string | null | undefined, string | null>;
  ended_at: ColumnType<string | null, string | null | undefined, string | null>;
  ended_by: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A sign-in refused because a local account with that email exists: offered to an administrator to link on purpose. */
export interface SsoLinkRequestsTable {
  id: Generated<string>;
  provider_id: string;
  subject: string;
  email: string;
  display_name: string | null;
  account_kind: string | null;
  created_at: Ts;
  last_seen_at: Ts;
}

/** Codes and ID tokens seen once, so a replay is refused. */
export interface SsoReplayGuardTable {
  key: string;
  expires_at: string;
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
  /** Structured, plain-language capture from the AA/CQ creation wizard - null means this row was created the old freeform way. */
  wizard_answers: Json<import('@tvmf/shared').AutoAttendantWizardAnswers | import('@tvmf/shared').CallQueueWizardAnswers> | null;
  wizard_version: number | null;
  /** FK -> discovery_voice_apps.id (ON DELETE SET NULL): the voice app this Call flow is the structured capture of. */
  voice_app_id: string | null;
  /** FK -> discovery_resource_accounts.id (ON DELETE SET NULL) - the resource account that answers this, if one is chosen. */
  resource_account_id: string | null;
  /** FK -> tenant_objects.id: the discovered auto attendant / call queue this row was made from (see 0061); null for a manual or wizard row. */
  tenant_object_id: string | null;
  /** Set once "Import to Design & Build" has run for this row. */
  imported_at: Ts | null;
  /** FK -> build_auto_attendants.id (ON DELETE SET NULL) - the row the wizard capture was imported into. */
  build_auto_attendant_id: string | null;
  /** FK -> build_call_queues.id (ON DELETE SET NULL) - the row the wizard capture was imported into. */
  build_call_queue_id: string | null;
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
  /** Per-site overview + assigned staff. Staff-managed (`discovery:sites:manage`). */
  overview: Json<import('@tvmf/shared').DiscoverySiteOverview>;
  paging: Json;
  created_at: Ts;
  /** 'project' until moved to 'operations'; only operations sites take service requests - see 0036_site_mode.sql. */
  mode: ColumnType<'project' | 'operations', 'project' | 'operations' | undefined, 'project' | 'operations'>;
  mode_changed_at: string | null;
  mode_changed_by: string | null;
  /** The site's Site Data review. Nothing is locked; changes after submission are recorded in discovery_site_changes. */
  review_status: ColumnType<'draft' | 'submitted' | 'accepted', 'draft' | 'submitted' | 'accepted' | undefined, 'draft' | 'submitted' | 'accepted'>;
  submitted_by: string | null;
  submitted_at: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
}

/** An address on a site besides its primary one (migration 0076): another building on a campus. Pinned on the map under the site's code. */
export interface DiscoverySiteAddressesTable {
  id: Generated<string>;
  site_id: string;
  label: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  sort_order: ColumnType<number, number | undefined, number>;
  created_at: Ts;
}

/** The stage a handset model has reached on a site (migration 0078); the quantities are counted from Site Data, not stored. */
export interface SiteHandsetTrackingTable {
  site_id: string;
  model_key: string;
  status: 'ordered' | 'delivered' | 'in_tooling' | 'installed';
  updated_by: string | null;
  updated_at: ColumnType<string, string | undefined, string>;
}

/** A change made to a site after it was submitted, for the engineer to see and acknowledge. */
export interface DiscoverySiteChangesTable {
  id: Generated<string>;
  site_id: string;
  changed_at: Ts;
  actor_id: string | null;
  actor_name: string | null;
  entity: string;
  entity_label: string | null;
  action: 'added' | 'changed' | 'removed';
  detail: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export interface DiscoveryNumberRangesTable {
  id: Generated<string>;
  range_start: string;
  range_end: string;
  kind: 'new' | 'port' | 'retain';
  carrier: string | null;
  /** Mirrors the owning number_port_requests row's status, if any - lets the Number Ranges grid show port progress with no join. */
  port_status: string | null;
  /** FK -> discovery_sites.sitecode (ON UPDATE CASCADE, ON DELETE SET NULL). */
  sitecode: string | null;
  loa_sent: ColumnType<boolean, boolean | undefined, boolean>;
  loa_completed: ColumnType<boolean, boolean | undefined, boolean>;
  comments: string | null;
  /** Port-in carrier transition (migration 0077): `carrier` is where the numbers are now, `new_carrier` where they are moving. */
  new_carrier: string | null;
  previous_carrier: string | null;
  port_order_ref: string | null;
  port_submitted_to_carrier_at: string | null;
  /** YYYY-MM-DD */
  port_foc_date: string | null;
  port_completed_at: string | null;
  port_completed_by: string | null;
  created_at: Ts;
}

/** Global catalog of document types a number-port request can ask for (LOA, CSR, ...) - editable by PM/Engineer, not hardcoded. */
export interface PortDocumentTypesTable {
  id: Generated<string>;
  key: string;
  label: string;
  ordinal: number;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
}

/** Which of the global catalog applies to one site - a country/site-specific subset. */
export interface SitePortDocumentTypesTable {
  site_id: string;
  document_type_id: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface NumberPortRequestsTable {
  id: Generated<string>;
  range_id: string;
  status: ColumnType<
    'draft' | 'submitted' | 'awaiting_documents' | 'complete',
    'draft' | 'submitted' | 'awaiting_documents' | 'complete' | undefined,
    'draft' | 'submitted' | 'awaiting_documents' | 'complete'
  >;
  submitted_by: string | null;
  submitted_at: string | null;
  reminder_sent_at: string | null;
  created_at: Ts;
}

export interface NumberPortRequestItemsTable {
  id: Generated<string>;
  request_id: string;
  document_type_id: string;
  note: string | null;
  status: ColumnType<
    'pending' | 'uploaded' | 'rejected' | 'waived',
    'pending' | 'uploaded' | 'rejected' | 'waived' | undefined,
    'pending' | 'uploaded' | 'rejected' | 'waived'
  >;
  reject_reason: string | null;
  file_id: string | null;
  updated_at: Ts;
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
  /** Released in Teams: not to be reassigned before this (migration 0066, number-cooloff.ts); null = free to use. */
  cooling_until: string | null;
  cooling_reason: string | null;
  /** What Teams says (migration 0074, number-reconcile.ts): set by the Discovery sync while the number is assigned in Teams, null otherwise. */
  live_status: string | null;
  live_holder_kind: 'user' | 'resource_account' | 'other' | null;
  live_holder_upn: string | null;
  live_holder_name: string | null;
  live_seen_at: string | null;
  /** Assigned only because Teams has it: no Site Data holder claims it. A claim by a holder takes it over. */
  live_only: ColumnType<boolean, boolean | undefined, boolean>;
  /** Plain-words clash between Teams and the Site Data holder; null = none. */
  conflict: string | null;
  created_at: Ts;
}

/** An uploaded audio prompt (migration 0069), imported to Teams by the worker in the live run that uses it. */
export interface VoiceAudioFilesTable {
  id: Generated<string>;
  filename: string;
  content_type: string;
  byte_size: number;
  content: Buffer;
  teams_audio_file_id: string | null;
  imported_at: string | null;
  uploaded_by: string | null;
  created_at: Ts;
}

/** The customer's number cool-off period, one row (migration 0066). */
export interface NumberPolicyTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  cooloff_days: ColumnType<number, number | undefined, number>;
}

/** Where the customer's Uptime Kuma status page is, one row (migration 0070). */
export interface DeviceMonitorSettingsTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  kuma_url: string | null;
  status_slug: string | null;
  last_polled_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  /** Phase 2 (migration 0071): Voxshift looks after Kuma for this customer. */
  managed: ColumnType<boolean, boolean | undefined, boolean>;
  kuma_admin_user: string | null;
  kuma_admin_pass_enc: string | null;
  sync_needed: ColumnType<boolean, boolean | undefined, boolean>;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

/** A device the customer wants watched; the worker keeps a Kuma monitor for it (migration 0071). */
export interface DeviceInventoryTable {
  id: Generated<string>;
  site_code: string;
  name: string;
  kind: ColumnType<string, string | undefined, string>;
  check_type: string;
  address: string;
  port: number | null;
  snmp_version: string | null;
  snmp_community_enc: string | null;
  snmp_username: string | null;
  snmp_oid: string | null;
  snmp_operator: string | null;
  snmp_expected: string | null;
  kuma_snmp_user: string | null;
  kuma_monitor_id: number | null;
  sync_state: ColumnType<string, string | undefined, string>;
  sync_error: string | null;
  removed: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<string, string | undefined, string>;
  updated_at: ColumnType<string, string | undefined, string>;
}

/** The current state of each monitor on the status page (migration 0070). */
export interface DeviceMonitorsTable {
  kuma_id: number;
  name: string;
  monitor_type: ColumnType<string, string | undefined, string>;
  group_name: string | null;
  sitecode: string | null;
  device_kind: ColumnType<string, string | undefined, string>;
  state: string;
  since: string;
  since_exact: ColumnType<boolean, boolean | undefined, boolean>;
  last_beat_at: string | null;
  response_ms: ColumnType<string | null, number | null | undefined, number | null>;
  message: ColumnType<string, string | undefined, string>;
  uptime_24h: ColumnType<string | null, number | null | undefined, number | null>;
  updated_at: ColumnType<string, string | undefined, string>;
  /** When an alert email last said this device was down (migration 0072). */
  last_alerted_at: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Who is emailed when a device goes down or comes back, and how often; one row (migration 0072). */
export interface DeviceAlertSettingsTable {
  id: ColumnType<boolean, boolean | undefined, boolean>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  frequency: ColumnType<string, string | undefined, string>;
  reminder_hours: ColumnType<number, number | undefined, number>;
  notify_engineers: ColumnType<boolean, boolean | undefined, boolean>;
  notify_project_managers: ColumnType<boolean, boolean | undefined, boolean>;
  recipients: ColumnType<string[], string | undefined, string>;
  /** bigint: the driver hands it back as a string. */
  cursor: ColumnType<string, string | undefined, string>;
  last_sent_at: string | null;
  updated_at: ColumnType<string, string | undefined, string>;
}

/** Every change of state seen, kept 90 days (migration 0070). */
export interface DeviceStatusChangesTable {
  id: Generated<string>;
  kuma_id: number;
  name: string;
  sitecode: string | null;
  device_kind: ColumnType<string, string | undefined, string>;
  from_state: string | null;
  to_state: string;
  at: string;
  message: ColumnType<string, string | undefined, string>;
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
  /** number the customer asked for (imported from a spreadsheet); free text,
   * not necessarily in inventory. Reconciled in Design & Build. */
  requested_number: string | null;
  /** FK -> tenant_users.id: the real tenant user this row was matched to (by lower(upn)). */
  tenant_user_id: string | null;
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

export interface DiscoveryVoiceAppsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  name: string;
  kind: 'auto_attendant' | 'call_queue';
  /** FK -> tenant_objects.id: the exact discovered voice app this row was added from (see 0060); null for one designed here. */
  tenant_object_id: string | null;
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

/** A resource account (Teams application instance): its own UPN, name and phone number; it answers for one voice app. See 0063. */
export interface DiscoveryResourceAccountsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE SET NULL). null = not tied to a site. */
  site_id: string | null;
  /** FK -> discovery_voice_apps.id (ON DELETE SET NULL): the voice app it answers for; null = not tied to one. */
  voice_app_id: string | null;
  name: string;
  /** Which kind of voice app it is for (its application id). */
  kind: 'auto_attendant' | 'call_queue';
  /** Blank until the account exists; matched to the live account when it does. */
  upn: string | null;
  /** FK -> tenant_objects.id: the exact discovered resource account this row was made from. */
  tenant_object_id: string | null;
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
  /** one of NETWORK_LOCATIONS (or legacy free text); drives the network diagram */
  location: string | null;
  vlan_id: number | null;
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

/**
 * Fields shared by build_users and build_caps - a "Teams identity" row (user or
 * common area phone) targeting the same set of number/policy/calling cmdlets.
 * Each concrete table adds its own discovery_*_id link (they seed from
 * different discovery_* tables) plus any type-specific columns.
 */
interface BuildIdentityRowBase {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE CASCADE). Build rows are always site-scoped. */
  site_id: string;
  upn: string;
  did: string | null;
  ext: string | null;
  e164: string | null;
  /**
   * FK -> phone_numbers.id (ON DELETE SET NULL). A plain reference to which
   * inventory row `e164` came from - NOT the same as phone_numbers.holder_id
   * (the exclusive claim), which for an imported number stays with
   * discovery_users/discovery_caps. Null e164 with a set phone_number_id
   * shouldn't happen; the reverse (e164 set, this null) means it was
   * imported before this column existed and not yet backfilled.
   */
  phone_number_id: string | null;
  number_type: string | null;
  revoke_ev: ColumnType<boolean, boolean | undefined, boolean>;
  hold_uri: string | null;
  action: string | null;
  migration_wave: string | null;
  /** policy assignments keyed by PolicyKey from @tvmf/shared - the name to deploy */
  policies: Json<Record<string, string | null>>;
  /**
   * FK -> tenant_policies.id per PolicyKey (ON DELETE SET NULL isn't
   * enforceable per-jsonb-key by Postgres, so this is app-enforced - see
   * BuildService.resolvePolicyIds). A plain reference to which discovered
   * policy `policies.<key>` came from, kept in sync by the API on every
   * write and re-resolved to the live name again at deploy time, so a
   * rename in the tenant doesn't silently deploy a stale name. See
   * 0018_build_policy_ids.sql.
   */
  policy_ids: Json<Record<string, string | null>>;
  voicemail: Json;
  call_forwarding: Json;
  delegates: Json;
  pickup_group: Json;
  comments: string | null;
  /** results of validating this row against the live tenant (snapshot from the last "Validate" action) */
  validation: Json;
  /** the engineer's accept/reject of a number change (see 0059_build_number_decision.sql); null = undecided */
  number_decision: ColumnType<unknown, unknown | undefined, unknown>;
  /** requested/completed dates + applied flags */
  status: Json;
  errors: string | null;
  hidden: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildUsersTable extends BuildIdentityRowBase {
  /** FK -> discovery_users.id (ON DELETE SET NULL): the row this was seeded from, for idempotent re-populate. */
  discovery_user_id: string | null;
}

export interface BuildCapsTable extends BuildIdentityRowBase {
  /** FK -> discovery_caps.id (ON DELETE SET NULL): the row this was seeded from, for idempotent re-populate. */
  discovery_cap_id: string | null;
  function: string | null;
  display_name: string | null;
  phone_model: string | null;
  device_config_profile: string | null;
  mac_address: string | null;
  serial_number: string | null;
  phone_location: string | null;
  lan_jack: string | null;
}

/** Per site: which real tenant_policies row a Site Data generic
 * calling-policy catalog entry resolves to for THIS site. See
 * 0023_build_templates_and_calling_policy_map.sql. */
export interface CallingPolicySiteMapTable {
  id: Generated<string>;
  site_id: string;
  discovery_calling_policy_id: string;
  tenant_policy_id: string;
  created_at: Ts;
  updated_at: Ts;
}

/** A named, reusable preset of policy targets + voicemail defaults for
 * Users or CAPs on one site - see 0023_build_templates_and_calling_policy_map.sql. */
export interface BuildTemplatesTable {
  id: Generated<string>;
  site_id: string;
  kind: 'user' | 'cap';
  name: string;
  policy_ids: Json<Record<string, string | null>>;
  policies: Json<Record<string, string | null>>;
  voicemail_enabled: boolean | null;
  voicemail_language: string | null;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildResourceAccountsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE CASCADE). Build rows are always site-scoped. */
  site_id: string;
  /** FK -> discovery_resource_accounts.id (ON DELETE SET NULL): the row this was seeded from. */
  discovery_resource_account_id: string | null;
  upn: string;
  display_name: string | null;
  kind: 'auto_attendant' | 'call_queue';
  location_id: string | null;
  phone_number: string | null;
  /** FK -> phone_numbers.id (ON DELETE SET NULL) - same plain reference as build_users/build_caps. */
  phone_number_id: string | null;
  number_type: string | null;
  voice_routing_policy: string | null;
  /** FK -> tenant_policies.id - same plain-reference pattern as build_users/build_caps.policy_ids. */
  voice_routing_policy_id: string | null;
  /** set once New-CsOnlineApplicationInstance has run - gates the number/policy assignment phase */
  application_id: string | null;
  /** Set when a "Resource Account Request" document was generated including this row - null = not yet requested. */
  requested_at: string | null;
  /** Set by Discovery's post-sync reconciliation once this UPN appears live (application_id auto-populated at the same time) - null if never auto-detected (e.g. application_id was set via the manual toggle instead). */
  linked_at: string | null;
  /** requested/completed dates, same shape as build_users.status */
  status: Json;
  errors: string | null;
  created_at: Ts;
  updated_at: Ts;
}

/** Set-CsTeamsSharedCallingRoutingPolicy-shaped row - see 0031_shared_calling_policies.sql for the cmdlet mapping. */
export interface BuildSharedCallingPoliciesTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE CASCADE). Build rows are always site-scoped. */
  site_id: string;
  /** New-/Set-CsTeamsSharedCallingRoutingPolicy -Identity. */
  name: string;
  /** FK -> build_resource_accounts.id (ON DELETE SET NULL) - -ResourceAccount, resolved to its live Identity at deploy time. */
  resource_account_id: string | null;
  /** -EmergencyNumbers - array of plain PSTN number strings. */
  emergency_numbers: Json;
  /** -Description. */
  description: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildAutoAttendantsTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE CASCADE). Build rows are always site-scoped. */
  site_id: string;
  /** FK -> discovery_voice_apps.id (ON DELETE SET NULL): the voice app this was seeded from - only ever set by Populate. */
  discovery_voice_app_id: string | null;
  name: string;
  /** build_resource_accounts.id array - which RA(s)/phone numbers this AA answers on, same pattern as build_call_queues' own field. An AA can have several, or none yet. */
  resource_accounts: Json;
  /** PowerShell-only access settings (migration 0068, voice-app-access.ts): UPN arrays and the dial-by-name extension; null = not managed. */
  authorized_users: Json | null;
  hide_authorized_users: Json | null;
  user_name_extension: 'None' | 'Office' | 'Department' | null;
  language: string | null;
  timezone: string | null;
  config: Json;
  /** Narrative-only fields carried through from discovery_resource_accounts by Populate - a human-readable fallback alongside the structured columns below, never read by planAutoAttendantRow. */
  business_hours: string | null;
  ooh_action: string | null;
  holiday: string | null;
  advanced_features: string | null;
  notes: string | null;
  /** Set-CsAutoAttendant -LanguageId (required to deploy, nullable until configured). */
  language_id: string | null;
  /** Set-CsAutoAttendant -TimeZoneId. */
  time_zone_id: string | null;
  /** Set-CsAutoAttendant -VoiceId. */
  voice_id: string | null;
  /** Set-CsAutoAttendant -EnableVoiceResponse. */
  voice_response_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Callable-entity reference ({kind:'user'|'external', upn|number}) -
   * Set-CsAutoAttendant -Operator. Null = no operator. Untyped `Json` (not
   * `Json<AutoAttendantCallableEntity>`) like build_call_queues' overflow/
   * timeout - cast at the read site instead, since a specifically-typed
   * `Json<T>` column would force Kysely to accept a real `T[]` on insert
   * for the array-shaped columns below, which pg then binds as a native
   * Postgres array instead of jsonb (see the JSON.stringify comment on
   * schema.ts's array columns) - untyped `Json` accepts the pre-stringified
   * string those inserts actually need.
   */
  operator: Json | null;
  /** { greetings, menu } - Set-CsAutoAttendant -DefaultCallFlow (business hours, or 24/7 if no after-hours flow is set). */
  default_call_flow: Json | null;
  /** { greetings, menu } - paired with `schedule` via a CallHandlingAssociation (Type AfterHours). */
  after_hours_call_flow: Json | null;
  /** Array of { name, callFlow, schedule } - one CallHandlingAssociation (Type Holiday) per entry. */
  holiday_call_flows: Json;
  /** { type, weekly?, fixed? } - the after-hours schedule (New-CsOnlineSchedule). Each holiday_call_flows entry carries its own schedule instead. */
  schedule: Json | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface BuildCallQueuesTable {
  id: Generated<string>;
  /** FK -> discovery_sites.id (ON DELETE CASCADE). Build rows are always site-scoped. */
  site_id: string;
  /** FK -> discovery_voice_apps.id (ON DELETE SET NULL): the voice app this was seeded from. */
  discovery_voice_app_id: string | null;
  name: string;
  /** build_resource_accounts.id array - which RA(s)/phone numbers present this queue. */
  resource_accounts: Json;
  /** PowerShell-only access settings (migration 0068, voice-app-access.ts): UPN arrays; null = not managed. */
  authorized_users: Json | null;
  hide_authorized_users: Json | null;
  voicemail_triage_template_id: string | null;
  /** Set-CsCallQueue -RoutingMethod. */
  routing_method: ColumnType<
    'Attendant' | 'Serial' | 'RoundRobin' | 'LongestIdle',
    'Attendant' | 'Serial' | 'RoundRobin' | 'LongestIdle' | undefined,
    'Attendant' | 'Serial' | 'RoundRobin' | 'LongestIdle'
  >;
  /** Set-CsCallQueue -AgentAlertTime (seconds, 15-180). */
  agent_alert_time: ColumnType<number, number | undefined, number>;
  /** Set-CsCallQueue -PresenceBasedRouting. */
  presence_based_routing: ColumnType<boolean, boolean | undefined, boolean>;
  /** Agent UPN strings - resolved to Entra object GUIDs at deploy time (Set-CsCallQueue -Users needs GUIDs, not UPNs). */
  agents: Json;
  /** { action, threshold, target } - Set-CsCallQueue -OverflowAction/-OverflowThreshold/-OverflowActionTarget. */
  overflow: Json;
  /** { action, threshold, target } - Set-CsCallQueue -TimeoutAction/-TimeoutThreshold/-TimeoutActionTarget. */
  timeout: Json;
  /** { action, threshold, target } - Set-CsCallQueue -NoAgentAction/-NoAgentActionTarget (zero agents opted in - distinct from Overflow/Timeout). */
  no_agent_action: Json;
  /** Set-CsCallQueue -NoAgentApplyTo ('AllCalls' | 'NewCalls'). */
  no_agent_apply_to: 'AllCalls' | 'NewCalls' | null;
  /** Set-CsCallQueue -LanguageId - required only when overflow/timeout/no-agent action is SharedVoicemail. */
  language_id: string | null;
  notes: string | null;
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
  /** Optional second device-code sign-in, to Microsoft Graph (read-only Group.Read.All) - lets an engineer search M365 groups instead of typing a raw Object ID. Independent of `status` above; a Teams session can be `active` with `graph_status` still `none`. */
  graph_status: ColumnType<
    'none' | 'pending' | 'active' | 'failed',
    'none' | 'pending' | 'active' | 'failed' | undefined,
    'none' | 'pending' | 'active' | 'failed'
  >;
  graph_user_code: string | null;
  graph_verification_uri: string | null;
  graph_upn: string | null;
  graph_expires_at: string | null;
  /** Why the last group-lookup sign-in failed, for the engineer to act on; null otherwise. */
  graph_error: string | null;
  /* deliberately NO token columns - see docs/SECURITY.md */
}

/** This tenant's M365 groups, cached from a single full Graph sweep (`/groups`) on Graph sign-in - not a general Entra ID inventory, just enough (id/name/mail) to search for the Shared Voicemail groupId field instead of typing a raw GUID. */
export interface TenantGroupsTable {
  id: Generated<string>;
  object_id: string;
  display_name: string;
  mail: string | null;
  synced_at: Ts;
}

/* ------------- Discovery: live customer-tenant inventory (docs/DISCOVERY.md) ------------- */

/** jsonb column with a DB default - optional on insert. */
type JsonOpt<T> = ColumnType<T, T | undefined, T>;

export interface TenantDiscoveryRunsTable {
  id: Generated<string>;
  connection_id: string | null;
  status: ColumnType<
    import('@tvmf/shared').TenantDiscoveryRunStatus,
    import('@tvmf/shared').TenantDiscoveryRunStatus | undefined,
    import('@tvmf/shared').TenantDiscoveryRunStatus
  >;
  /** 'targeted' = a Design & Build Validate check (migration 0044) */
  kind: ColumnType<
    import('@tvmf/shared').TenantDiscoveryRunKind,
    import('@tvmf/shared').TenantDiscoveryRunKind | undefined,
    import('@tvmf/shared').TenantDiscoveryRunKind
  >;
  started_by: string;
  started_at: string | null;
  finished_at: string | null;
  /** object types this run covered; null = a full discovery */
  scope_types: import('@tvmf/shared').TenantObjectType[] | null;
  progress: JsonOpt<import('@tvmf/shared').TenantDiscoveryProgress>;
  summary: JsonOpt<Record<string, unknown>>;
  error: string | null;
  created_at: Ts;
}

/** Current snapshot of every discovered object; `search` is a generated tsvector (never written). */
export interface TenantObjectsTable {
  id: Generated<string>;
  object_type: string;
  object_key: string;
  display_name: string | null;
  data: Json<Record<string, unknown>>;
  search: ColumnType<string, never, never>;
  first_seen_run_id: string | null;
  last_seen_run_id: string | null;
  discovered_at: Ts;
  /** when `data` last actually changed (vs `discovered_at` = last seen) */
  content_changed_at: string | null;
  /** sha1 of the canonical JSON of `data` (migration 0080); null until a sync has written it */
  content_hash: string | null;
  // last_seen_run_id / discovered_at: the run that last wrote this row. A sync no longer writes an unchanged object (migration 0081);
  // the time it was last seen is the later of discovered_at and tenant_object_sweeps.swept_at for its type.
  removed_at: string | null;
}

/** One recorded change to a `tenant_objects` row on a given run. */
export interface TenantObjectVersionsTable {
  id: Generated<string>;
  object_id: string;
  run_id: string | null;
  object_type: import('@tvmf/shared').TenantObjectType;
  object_key: string;
  display_name: string | null;
  change_kind: import('@tvmf/shared').TenantObjectChangeKind;
  changed_fields: ColumnType<string[], string[] | undefined, string[]>;
  // objects (or null) - pg serialises a plain object to jsonb fine; only arrays need JSON.stringify
  before: Json<Record<string, unknown>> | null;
  after: Json<Record<string, unknown>> | null;
  changed_at: Ts;
}

export interface TenantUsersTable {
  id: Generated<string>;
  object_id: string;
  upn: string;
  entra_id: string | null;
  display_name: string | null;
  account_type: string | null;
  account_enabled: boolean | null;
  enterprise_voice_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  line_uri: string | null;
  /** From a targeted Get-CsOnlineVoicemailUserSettings check (Validate against tenant), not the full-tenant sweep - null until that's run for this UPN. */
  voicemail_enabled: boolean | null;
  voicemail_prompt_language: string | null;
  /** Get-CsUserCallingSettings as Design & Build designs it ({callForwarding, pickupGroup, delegates}); read for voice-enabled users by the sync. */
  calling_settings: JsonOpt<unknown>;
  /** Get-CsOnlineVoicemailUserSettings as Teams returns it. */
  voicemail_settings: JsonOpt<unknown>;
  voice_settings_at: string | null;
  telephone_numbers: JsonOpt<{ number: string; category?: string }[]>;
  feature_types: ColumnType<string[], string[] | undefined, string[]>;
  assigned_plans: JsonOpt<unknown[]>;
  usage_location: string | null;
  department: string | null;
  job_title: string | null;
  interpreted_user_type: string | null;
  policies: JsonOpt<Record<string, string | null>>;
  effective_policy_assignments: JsonOpt<unknown[]>;
  when_changed: string | null;
  /** the run that last wrote this row (a sync leaves an unchanged user alone, migration 0081); a targeted check always writes */
  last_seen_run_id: string | null;
  /** sha1 of what the row was projected from (migration 0081): equal = nothing to rewrite */
  projection_hash: string | null;
  removed_at: string | null;
}

/** When each object type was last read in full by a sync (migration 0081): "Last seen" for an object that has not changed. */
export interface TenantObjectSweepsTable {
  object_type: string;
  run_id: string | null;
  swept_at: string;
}

export interface TenantPoliciesTable {
  id: Generated<string>;
  object_id: string;
  policy_type: string;
  identity: string;
  name: string;
  is_global: ColumnType<boolean, boolean | undefined, boolean>;
  data: Json<Record<string, unknown>>;
  last_seen_run_id: string | null;
  removed_at: string | null;
}

export interface TenantDiscoveryConfigTable {
  id: Generated<string>;
  filter_users: ColumnType<boolean, boolean | undefined, boolean>;
  notify_on_complete: ColumnType<boolean, boolean | undefined, boolean>;
  /** after each full run, add objects whose number is in a site's range to that site (migration 0075) */
  auto_add_by_number_range: ColumnType<boolean, boolean | undefined, boolean>;
  auto_add_last_run_id: string | null;
  auto_add_last_at: string | null;
  auto_add_last_summary: Json<Record<string, unknown>> | null;
  updated_by: string | null;
  updated_at: Ts;
  created_at: Ts;
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
  /** Post-deploy live re-check (migration 0046) - a DeploymentVerification, null until one has run. */
  verification: ColumnType<import('@tvmf/shared').DeploymentVerification | null, import('@tvmf/shared').DeploymentVerification | null | undefined, import('@tvmf/shared').DeploymentVerification | null>;
  /** Scheduled cutover (migration 0067): when a queued live run starts; null = at once. */
  run_at: string | null;
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

/** Latest drift check for a site (migration 0065, packages/db/src/drift.ts). */
export interface DeploymentDriftTable {
  site_id: string;
  drifted: ColumnType<number, number | undefined, number>;
  awaiting_sync: ColumnType<number, number | undefined, number>;
  rows: ColumnType<import('@tvmf/shared').DriftRow[], string | undefined, string>;
  run_id: string | null;
  computed_at: ColumnType<string, string | undefined, string>;
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
  /** FK -> files.id (ON DELETE SET NULL) - the generated .docx, category 'handover_pack'. */
  file_id: string | null;
  /** Set together when a draft is issued (the table's CHECK keeps status and issued_at consistent). */
  issued_by: string | null;
  issued_at: string | null;
  created_at: Ts;
}

export interface ServiceRequestsTable {
  id: Generated<string>;
  /** per-customer sequence, shown as SR-0001 */
  number: Generated<number>;
  type: import('@tvmf/shared').SrType;
  title: string;
  site_id: string | null;
  details: Json;
  priority: ColumnType<import('@tvmf/shared').SrPriority, import('@tvmf/shared').SrPriority | undefined, import('@tvmf/shared').SrPriority>;
  status: ColumnType<import('@tvmf/shared').SrStatus, import('@tvmf/shared').SrStatus | undefined, import('@tvmf/shared').SrStatus>;
  target_date: string | null;
  requested_by: string;
  assigned_to: string | null;
  created_at: Ts;
  updated_at: Ts;
  planned_at: string | null;
  built_at: string | null;
  deployed_at: string | null;
  cancelled_at: string | null;
  /** 0039_sr_conversation_workflow.sql */
  declined_at: ColumnType<string | null, string | null | undefined, string | null>;
  reopened_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** Set while the team is waiting for the customer's reply. */
  waiting_since: ColumnType<string | null, string | null | undefined, string | null>;
  /** Total seconds spent waiting on the customer - left out of response/resolution targets. */
  waiting_seconds: ColumnType<number, number | undefined, number>;
  waiting_reminded_at: ColumnType<string | null, string | null | undefined, string | null>;
  waiting_reminders: ColumnType<number, number | undefined, number>;
  /** The team's first reply, question or move - the response target is measured to it. */
  first_response_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** Target emails already sent: { response_warning, response_breached, resolution_warning, resolution_breached } -> ISO time. */
  sla_notified: ColumnType<Record<string, string>, string | undefined, string>;
  /** 0042_sr_phase4.sql - null when the type needs no approval. */
  approval_status: ColumnType<import('@tvmf/shared').SrApprovalStatus | null, import('@tvmf/shared').SrApprovalStatus | null | undefined, import('@tvmf/shared').SrApprovalStatus | null>;
  approval_by: ColumnType<string | null, string | null | undefined, string | null>;
  approval_at: ColumnType<string | null, string | null | undefined, string | null>;
  approval_note: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0052_sr_agents.sql */
  assigned_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  agent_hold: ColumnType<boolean, boolean | undefined, boolean>;
  incident_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface ServiceRequestEventsTable {
  id: Generated<string>;
  request_id: string;
  kind: 'created' | 'status_changed' | 'assigned' | 'comment' | 'build_drafted' | 'deployment' | 'waiting' | 'resumed' | 'approval' | 'attachment' | 'claim_started' | 'claim_released' | 'handoff' | 'proposal' | 'proposal_decided' | 'whatif';
  from_status: string | null;
  to_status: string | null;
  body: string | null;
  internal: ColumnType<boolean, boolean | undefined, boolean>;
  /** build_drafted only: the Design & Build rows it made - see 0037_sr_build_drafted_event.sql. */
  // Written as JSON.stringify(...): pg would bind a plain array as a Postgres array, not jsonb.
  links: ColumnType<import('@tvmf/shared').SrBuildLink[] | null, string | null | undefined, string | null>;
  /** 'deployment' only: the run that finished - see 0038_sr_design_items.sql. */
  deployment_id: ColumnType<string | null, string | null | undefined, string | null>;
  author_id: string;
  /** 0052_sr_agents.sql */
  actor_type: ColumnType<'user' | 'agent' | 'system', 'user' | 'agent' | 'system' | undefined, 'user' | 'agent' | 'system'>;
  meta: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Ts;
}


/** Incident management - see 0047_incidents.sql and packages/shared/src/incidents.ts. */
export interface IncidentsTable {
  id: Generated<string>;
  /** per-customer sequence, shown as INC-0001 */
  number: Generated<number>;
  title: string;
  description: string;
  category: string;
  subcategory: string | null;
  site_id: string | null;
  impact: import('@tvmf/shared').IncImpact;
  urgency: import('@tvmf/shared').IncUrgency;
  priority: import('@tvmf/shared').IncPriority;
  priority_overridden: ColumnType<boolean, boolean | undefined, boolean>;
  status: ColumnType<import('@tvmf/shared').IncStatus, import('@tvmf/shared').IncStatus | undefined, import('@tvmf/shared').IncStatus>;
  hold_reason: ColumnType<import('@tvmf/shared').IncHoldReason | null, import('@tvmf/shared').IncHoldReason | null | undefined, import('@tvmf/shared').IncHoldReason | null>;
  source: ColumnType<import('@tvmf/shared').IncSource, import('@tvmf/shared').IncSource | undefined, import('@tvmf/shared').IncSource>;
  dedup_key: ColumnType<string | null, string | null | undefined, string | null>;
  // Written as JSON.stringify(...) like the other jsonb columns.
  details: ColumnType<import('@tvmf/shared').IncDetails, string, string>;
  reporter_id: string;
  assigned_to: ColumnType<string | null, string | null | undefined, string | null>;
  assigned_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  duplicate_of: ColumnType<string | null, string | null | undefined, string | null>;
  version: ColumnType<number, number | undefined, number>;
  created_at: Ts;
  updated_at: Ts;
  acknowledged_at: ColumnType<string | null, string | null | undefined, string | null>;
  restored_at: ColumnType<string | null, string | null | undefined, string | null>;
  resolved_at: ColumnType<string | null, string | null | undefined, string | null>;
  closed_at: ColumnType<string | null, string | null | undefined, string | null>;
  cancelled_at: ColumnType<string | null, string | null | undefined, string | null>;
  reopened_at: ColumnType<string | null, string | null | undefined, string | null>;
  paused_since: ColumnType<string | null, string | null | undefined, string | null>;
  paused_seconds: ColumnType<number, number | undefined, number>;
  /** 0048_incident_pause_log.sql - closed pauses, for working-hours clocks. Written as JSON.stringify(...). */
  pause_log: ColumnType<import('@tvmf/shared').IncPauseInterval[], string | undefined, string>;
  waiting_reminded_at: ColumnType<string | null, string | null | undefined, string | null>;
  waiting_reminders: ColumnType<number, number | undefined, number>;
  sla_notified: ColumnType<Record<string, string>, string | undefined, string>;
  /** 0049_incident_major_problems.sql - major incident, parent/child and problem link. */
  major: ColumnType<boolean, boolean | undefined, boolean>;
  major_declared_at: ColumnType<string | null, string | null | undefined, string | null>;
  major_declared_by: ColumnType<string | null, string | null | undefined, string | null>;
  major_ended_at: ColumnType<string | null, string | null | undefined, string | null>;
  lead_id: ColumnType<string | null, string | null | undefined, string | null>;
  comms_id: ColumnType<string | null, string | null | undefined, string | null>;
  update_interval_minutes: ColumnType<number | null, number | null | undefined, number | null>;
  next_update_due_at: ColumnType<string | null, string | null | undefined, string | null>;
  update_reminded_at: ColumnType<string | null, string | null | undefined, string | null>;
  update_escalated_at: ColumnType<string | null, string | null | undefined, string | null>;
  parent_id: ColumnType<string | null, string | null | undefined, string | null>;
  problem_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0050_incident_agents.sql - a person took over; agents may read but not write until it is handed back. */
  agent_hold: ColumnType<boolean, boolean | undefined, boolean>;
}

/** A problem record: the cause behind one or more incidents - see 0049_incident_major_problems.sql. */
export interface ProblemsTable {
  id: Generated<string>;
  /** per-customer sequence, shown as PRB-0001 */
  number: Generated<number>;
  title: string;
  description: ColumnType<string, string | undefined, string>;
  category: ColumnType<string | null, string | null | undefined, string | null>;
  subcategory: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<import('@tvmf/shared').IncProblemStatus, import('@tvmf/shared').IncProblemStatus | undefined, import('@tvmf/shared').IncProblemStatus>;
  root_cause: ColumnType<string, string | undefined, string>;
  workaround: ColumnType<string, string | undefined, string>;
  customer_note: ColumnType<string, string | undefined, string>;
  owner_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: string;
  created_at: Ts;
  updated_at: Ts;
  resolved_at: ColumnType<string | null, string | null | undefined, string | null>;
}

/** One post-incident review per incident. */
export interface IncidentReviewsTable {
  incident_id: string;
  status: ColumnType<'draft' | 'shared', 'draft' | 'shared' | undefined, 'draft' | 'shared'>;
  summary: ColumnType<string, string | undefined, string>;
  cause: ColumnType<string, string | undefined, string>;
  went_well: ColumnType<string, string | undefined, string>;
  went_badly: ColumnType<string, string | undefined, string>;
  // Written as JSON.stringify(...).
  actions: ColumnType<import('@tvmf/shared').IncReviewAction[], string | undefined, string>;
  created_by: string;
  created_at: Ts;
  updated_by: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: Ts;
  shared_at: ColumnType<string | null, string | null | undefined, string | null>;
  shared_by: ColumnType<string | null, string | null | undefined, string | null>;
}

/** A lease on an incident: who is working it right now - see 0050_incident_agents.sql. */
export interface ServiceRequestClaimsTable {
  id: Generated<string>;
  request_id: string;
  agent_id: string;
  note: ColumnType<string, string | undefined, string>;
  started_at: Ts;
  expires_at: string;
  released_at: string | null;
  release_reason: 'released' | 'expired' | 'revoked' | 'handed_off' | null;
}

export interface ServiceRequestActionsTable {
  id: Generated<string>;
  request_id: string;
  agent_id: string;
  kind: string;
  action_class: string;
  params: ColumnType<Record<string, unknown>, string | undefined, string>;
  rationale: ColumnType<string, string | undefined, string>;
  risk: ColumnType<'low' | 'medium' | 'high', 'low' | 'medium' | 'high' | undefined, 'low' | 'medium' | 'high'>;
  state: ColumnType<import('@tvmf/shared').AgentProposalState, import('@tvmf/shared').AgentProposalState | undefined, import('@tvmf/shared').AgentProposalState>;
  decided_by: ColumnType<string | null, string | null | undefined, string | null>;
  decided_at: ColumnType<string | null, string | null | undefined, string | null>;
  decision_note: ColumnType<string | null, string | null | undefined, string | null>;
  connection_id: ColumnType<string | null, string | null | undefined, string | null>;
  fingerprint: ColumnType<string | null, string | null | undefined, string | null>;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  expires_at: string;
  finished_at: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface IncidentKnowledgeTable {
  id: Generated<string>;
  title: string;
  category: string;
  subcategory: string | null;
  symptoms: ColumnType<string, string | undefined, string>;
  fix: string;
  customer_text: ColumnType<string, string | undefined, string>;
  source_incident_id: string | null;
  helpful: ColumnType<number, number | undefined, number>;
  not_helpful: ColumnType<number, number | undefined, number>;
  archived: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface IncidentDiagnosticsTable {
  id: Generated<string>;
  incident_id: string;
  runbook: import('@tvmf/shared').DiagRunbookKey;
  input: ColumnType<string, string | undefined, string>;
  subject: ColumnType<string, string | undefined, string>;
  status: import('@tvmf/shared').DiagOutcome;
  summary: ColumnType<string, string | undefined, string>;
  findings: ColumnType<import('@tvmf/shared').DiagFinding[], string, string>;
  data_as_of: string | null;
  actor_type: ColumnType<'user' | 'agent' | 'system', 'user' | 'agent' | 'system' | undefined, 'user' | 'agent' | 'system'>;
  run_by: string | null;
  proposal_id: string | null;
  created_at: Ts;
}

export interface IncidentClaimsTable {
  id: Generated<string>;
  incident_id: string;
  agent_id: string;
  note: ColumnType<string, string | undefined, string>;
  started_at: Ts;
  expires_at: string;
  released_at: ColumnType<string | null, string | null | undefined, string | null>;
  release_reason: ColumnType<'released' | 'expired' | 'revoked' | 'handed_off' | null, 'released' | 'expired' | 'revoked' | 'handed_off' | null | undefined, 'released' | 'expired' | 'revoked' | 'handed_off' | null>;
}

/** An agent's proposal for a person to decide. */
export interface IncidentActionsTable {
  id: Generated<string>;
  incident_id: string;
  agent_id: string;
  kind: string;
  action_class: string;
  // Written as JSON.stringify(...).
  params: ColumnType<Record<string, unknown>, string | undefined, string>;
  rationale: ColumnType<string, string | undefined, string>;
  risk: ColumnType<'low' | 'medium' | 'high', 'low' | 'medium' | 'high' | undefined, 'low' | 'medium' | 'high'>;
  state: ColumnType<import('@tvmf/shared').AgentProposalState, import('@tvmf/shared').AgentProposalState | undefined, import('@tvmf/shared').AgentProposalState>;
  decided_by: ColumnType<string | null, string | null | undefined, string | null>;
  decided_at: ColumnType<string | null, string | null | undefined, string | null>;
  decision_note: ColumnType<string | null, string | null | undefined, string | null>;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  expires_at: string;
  finished_at: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface IncidentEventsTable {
  id: Generated<string>;
  incident_id: string;
  kind: import('@tvmf/shared').IncEventKind;
  from_status: string | null;
  to_status: string | null;
  body: string | null;
  internal: ColumnType<boolean, boolean | undefined, boolean>;
  actor_type: ColumnType<import('@tvmf/shared').IncActorType, import('@tvmf/shared').IncActorType | undefined, import('@tvmf/shared').IncActorType>;
  author_id: string | null;
  meta: ColumnType<Record<string, unknown>, string | undefined, string>;
  idempotency_key: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
}

export interface IncidentItemsTable {
  id: Generated<string>;
  incident_id: string;
  kind: import('@tvmf/shared').IncItemKind;
  ref: string;
  label: string | null;
  created_by: string | null;
  created_at: Ts;
}

export interface IncidentWatchersTable {
  incident_id: string;
  user_id: string;
  added_by: string | null;
  created_at: Ts;
}

/** Design & Build rows (or a new site) designed for a service request - see 0038_sr_design_items.sql. */
export interface ServiceRequestItemsTable {
  request_id: string;
  kind: import('@tvmf/shared').SrItemKind;
  /** Plain reference into the table `kind` names. */
  row_id: string;
  created_by: string | null;
  created_at: Ts;
}

/** One note per (section_key, site_id); site_id NULL applies to every site. */
export interface HandoverNotesTable {
  id: Generated<string>;
  section_key: 'service_support_model' | 'paging' | 'teams_configuration' | 'outstanding_actions';
  site_id: string | null;
  body: string;
  updated_by: string;
  updated_at: Ts;
}

export interface HandoverSectionsTable {
  id: Generated<string>;
  pack_id: string;
  key: string;
  title: string;
  ordinal: number;
  content: Json;
}

/**
 * General-purpose per-tenant file storage - bytes live on local disk under
 * FILES_DIR, this row is just the index. First consumer: Deployment
 * change-recording .docx files (category deployment_change_document);
 * category is a closed CHECK list in the migration, so future producers
 * (Site Data, Discovery, Design & Build, Service Handover) each add
 * their own value(s) via a follow-up migration when they integrate.
 */
export interface FilesTable {
  id: Generated<string>;
  category: 'deployment_change_document' | 'number_port_document' | 'resource_account_request' | 'handover_pack' | 'service_request_attachment' | 'incident_attachment';
  source_type: string;
  source_id: string;
  site_id: string | null;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_path: string;
  uploaded_by: string | null;
  metadata: Json;
  created_at: Ts;
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

/* ------------------------------ agents (platform) ------------------------------ */

/** An AI agent that works incidents - see 0017_agents.sql and docs/AGENTS.md. */
export interface InboundReplyTokensTable {
  token: string;
  tenant_id: string;
  incident_id: string;
  user_id: string;
  created_at: Ts;
  expires_at: string;
}

export interface InboundEmailLogTable {
  id: Generated<string>;
  message_id: string;
  from_email: string;
  subject: ColumnType<string, string | undefined, string>;
  outcome: string;
  detail: ColumnType<string, string | undefined, string>;
  tenant_id: ColumnType<string | null, string | null | undefined, string | null>;
  incident_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
}

export interface MspNotificationsTable {
  id: Generated<string>;
  msp_id: string;
  tenant_id: ColumnType<string | null, string | null | undefined, string | null>;
  kind: 'incident' | 'major' | 'sla' | 'test';
  card: ColumnType<import('@tvmf/shared').MspNotifyCard, string, string>;
  status: ColumnType<'queued' | 'sent' | 'failed', 'queued' | 'sent' | 'failed' | undefined, 'queued' | 'sent' | 'failed'>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<string, string | undefined, string>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  sent_at: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface IntakeSourcesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  kind: ColumnType<import('@tvmf/shared').IntakeKind, import('@tvmf/shared').IntakeKind | undefined, import('@tvmf/shared').IntakeKind>;
  config: ColumnType<import('@tvmf/shared').IntakeConfig, string | undefined, string>;
  secret_hash: string;
  last4: string;
  ip_allow: ColumnType<string[], string[] | undefined, string[]>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  last_used_at: ColumnType<string | null, string | null | undefined, string | null>;
  alerts_received: ColumnType<number, number | undefined, number>;
}

export interface AgentsTable {
  id: Generated<string>;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  kind: ColumnType<import('@tvmf/shared').AgentKind, import('@tvmf/shared').AgentKind | undefined, import('@tvmf/shared').AgentKind>;
  msp_id: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<import('@tvmf/shared').AgentStatus, import('@tvmf/shared').AgentStatus | undefined, import('@tvmf/shared').AgentStatus>;
  model_label: ColumnType<string, string | undefined, string>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
  updated_at: Ts;
  last_seen_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0018_builtin_agents.sql - set for the assistants Voxshift runs itself. */
  builtin_key: ColumnType<import('@tvmf/shared').BuiltinAgentKey | null, import('@tvmf/shared').BuiltinAgentKey | null | undefined, import('@tvmf/shared').BuiltinAgentKey | null>;
  /** 0024_agent_works_on.sql - the areas this assistant may work in: incidents, service requests, or both. */
  works_on: ColumnType<import('@tvmf/shared').AgentDomain[], import('@tvmf/shared').AgentDomain[] | undefined, import('@tvmf/shared').AgentDomain[]>;
}

export interface AgentTokensTable {
  id: Generated<string>;
  agent_id: string;
  name: string;
  last4: string;
  secret_hash: string;
  scopes: ColumnType<import('@tvmf/shared').AgentScope[], import('@tvmf/shared').AgentScope[] | undefined, import('@tvmf/shared').AgentScope[]>;
  ip_allow: ColumnType<string[], string[] | undefined, string[]>;
  expires_at: ColumnType<string | null, string | null | undefined, string | null>;
  last_used_at: ColumnType<string | null, string | null | undefined, string | null>;
  revoked_at: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
}

export interface AgentCustomerPolicyTable {
  agent_id: string;
  tenant_id: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  // Written as JSON.stringify(...).
  autonomy: ColumnType<import('@tvmf/shared').AgentAutonomy, string | undefined, string>;
  updated_by: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: Ts;
}

export interface AgentKillSwitchTable {
  id: ColumnType<number, number | undefined, number>;
  all_disabled: ColumnType<boolean, boolean | undefined, boolean>;
  note: ColumnType<string | null, string | null | undefined, string | null>;
  changed_by: ColumnType<string | null, string | null | undefined, string | null>;
  changed_at: Ts;
}

export interface AgentEventsTable {
  id: Generated<string>;
  tenant_id: string;
  incident_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 0019 - a service request event */
  request_id: ColumnType<string | null, string | null | undefined, string | null>;
  kind: string;
  agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  payload: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Ts;
}

export interface AgentWebhooksTable {
  id: Generated<string>;
  agent_id: string;
  url: string;
  secret_enc: string;
  kinds: ColumnType<string[], string[] | undefined, string[]>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  cursor: ColumnType<string, string | number | undefined, string | number>;
  failures: ColumnType<number, number | undefined, number>;
  next_attempt_at: Ts;
  last_status: ColumnType<string | null, string | null | undefined, string | null>;
  last_delivery_at: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Ts;
}

export interface AgentRequestsTable {
  agent_id: string;
  idem_key: string;
  status: ColumnType<'running' | 'done', 'running' | 'done' | undefined, 'running' | 'done'>;
  response: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  created_at: Ts;
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
  msps: MspsTable;
  tenant_memberships: TenantMembershipsTable;
  totp_secrets: TotpSecretsTable;
  auth_sessions: AuthSessionsTable;
  sso_providers: SsoProvidersTable;
  external_identities: ExternalIdentitiesTable;
  sso_link_requests: SsoLinkRequestsTable;
  sso_access_requests: SsoAccessRequestsTable;
  sso_replay_guard: SsoReplayGuardTable;
  invitations: InvitationsTable;
  email_messages: EmailMessagesTable;
  feature_requests: FeatureRequestsTable;
  bug_reports: BugReportsTable;
  platform_audit_log: PlatformAuditLogTable;
  maintenance_notice: MaintenanceNoticeTable;
  app_settings: AppSettingsTable;
  monitoring_admin: MonitoringAdminTable;
  agents: AgentsTable;
  intake_sources: IntakeSourcesTable;
  msp_notifications: MspNotificationsTable;
  inbound_reply_tokens: InboundReplyTokensTable;
  inbound_email_log: InboundEmailLogTable;
  agent_tokens: AgentTokensTable;
  agent_customer_policy: AgentCustomerPolicyTable;
  agent_kill_switch: AgentKillSwitchTable;
  agent_events: AgentEventsTable;
  agent_webhooks: AgentWebhooksTable;
  agent_requests: AgentRequestsTable;
  // tenant
  discovery: DiscoveryTable;
  discovery_sites: DiscoverySitesTable;
  discovery_site_addresses: DiscoverySiteAddressesTable;
  site_handset_tracking: SiteHandsetTrackingTable;
  discovery_site_changes: DiscoverySiteChangesTable;
  discovery_number_ranges: DiscoveryNumberRangesTable;
  port_document_types: PortDocumentTypesTable;
  site_port_document_types: SitePortDocumentTypesTable;
  number_port_requests: NumberPortRequestsTable;
  number_port_request_items: NumberPortRequestItemsTable;
  discovery_network: DiscoveryNetworkTable;
  discovery_flows: DiscoveryFlowsTable;
  discovery_calling_policies: DiscoveryCallingPoliciesTable;
  phone_numbers: PhoneNumbersTable;
  discovery_users: DiscoveryUsersTable;
  discovery_caps: DiscoveryCapsTable;
  discovery_voice_apps: DiscoveryVoiceAppsTable;
  discovery_resource_accounts: DiscoveryResourceAccountsTable;
  attachments: AttachmentsTable;
  build_users: BuildUsersTable;
  build_caps: BuildCapsTable;
  build_templates: BuildTemplatesTable;
  calling_policy_site_map: CallingPolicySiteMapTable;
  build_resource_accounts: BuildResourceAccountsTable;
  build_shared_calling_policies: BuildSharedCallingPoliciesTable;
  build_auto_attendants: BuildAutoAttendantsTable;
  build_call_queues: BuildCallQueuesTable;
  build_m365_groups: BuildM365GroupsTable;
  connections: ConnectionsTable;
  tenant_groups: TenantGroupsTable;
  tenant_discovery_runs: TenantDiscoveryRunsTable;
  tenant_objects: TenantObjectsTable;
  tenant_object_versions: TenantObjectVersionsTable;
  tenant_users: TenantUsersTable;
  tenant_object_sweeps: TenantObjectSweepsTable;
  tenant_policies: TenantPoliciesTable;
  tenant_discovery_config: TenantDiscoveryConfigTable;
  deployments: DeploymentsTable;
  deployment_changes: DeploymentChangesTable;
  deployment_drift: DeploymentDriftTable;
  number_policy: NumberPolicyTable;
  device_monitor_settings: DeviceMonitorSettingsTable;
  device_monitors: DeviceMonitorsTable;
  device_status_changes: DeviceStatusChangesTable;
  device_alert_settings: DeviceAlertSettingsTable;
  device_inventory: DeviceInventoryTable;
  voice_audio_files: VoiceAudioFilesTable;
  deployment_scripts: DeploymentScriptsTable;
  handover_packs: HandoverPacksTable;
  handover_sections: HandoverSectionsTable;
  handover_notes: HandoverNotesTable;
  service_requests: ServiceRequestsTable;
  service_request_events: ServiceRequestEventsTable;
  service_request_items: ServiceRequestItemsTable;
  incidents: IncidentsTable;
  incident_events: IncidentEventsTable;
  incident_items: IncidentItemsTable;
  incident_watchers: IncidentWatchersTable;
  problems: ProblemsTable;
  incident_reviews: IncidentReviewsTable;
  incident_claims: IncidentClaimsTable;
  incident_diagnostics: IncidentDiagnosticsTable;
  incident_knowledge: IncidentKnowledgeTable;
  service_request_claims: ServiceRequestClaimsTable;
  service_request_actions: ServiceRequestActionsTable;
  incident_actions: IncidentActionsTable;
  files: FilesTable;
  audit_log: TenantAuditLogTable;
}

export const PLATFORM_SCHEMA = 'platform';
