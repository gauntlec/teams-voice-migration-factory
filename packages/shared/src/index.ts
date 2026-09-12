export * from './rbac';
export * from './domain';
export * from './dto';
export * from './email';
export * from './deployment';

import type { CmdletInvocation } from './deployment';

/** Header the web app sends to select the active tenant for `/t/:tenantId/*`. */
export const TENANT_HEADER = 'x-tenant-id';

/** One page of a paginated Data Collection list endpoint. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/** One customer the signed-in user can act in. */
export interface MeTenant {
  id: string;
  slug: string;
  name: string;
  /** true when this membership is limited to specific sites (a "site contact"). */
  siteScoped: boolean;
  /** the site ids this membership is limited to; empty when not site-scoped. */
  siteIds: string[];
}

/** Shape of the authenticated principal returned by `GET /auth/me`. */
export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: import('./rbac').Role;
  totpEnrolled: boolean;
  tenants: MeTenant[];
}

/** A feature request as returned by `GET /feature-requests` (board card). */
export interface FeatureRequest {
  id: string;
  title: string;
  area: import('./domain').FeatureArea;
  status: import('./domain').FeatureStatus;
  priority: import('./domain').FeaturePriority;
  problem: string;
  proposal: string;
  current_behavior: string | null;
  examples: string | null;
  acceptance: string | null;
  constraints: string | null;
  affected_roles: import('./rbac').Role[];
  decision_note: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
}

/* ------------------ Discovery (live customer-tenant inventory) ------------------ */

/** Tally of how many objects changed in a run, by change kind. */
export interface TenantDiscoveryChangeCounts {
  added: number;
  updated: number;
  removed: number;
  readded: number;
}

/** Progress the worker writes as a discovery run advances. */
export interface TenantDiscoveryProgress {
  step: import('./domain').TenantDiscoveryStep | null;
  /** steps completed so far, in order */
  completed: import('./domain').TenantDiscoveryStep[];
  /** objects stored per object type during this run (updated live within a step) */
  counts: Partial<Record<import('./domain').TenantObjectType, number>>;
  /** how many objects were added / updated / removed / re-added this run */
  changed: TenantDiscoveryChangeCounts;
  /**
   * Accounts deliberately left out of the store this run, by reason. Currently
   * `notLicensed` = `AccountType='User'` accounts with no Teams licence (the
   * default filter; off when the engineer opts in or licence data was
   * unavailable). Persisted so a low user count is always explained.
   */
  skipped?: { notLicensed: number };
  /** set when the run could not read licence data and so did not filter users */
  filterDisabledReason?: string | null;
  /** free-text detail for the current step, e.g. "Fetching users…" / "Storing 3,400 users…" */
  note?: string | null;
  /** non-fatal step errors (the run carries on) */
  errors: { step: import('./domain').TenantDiscoveryStep; message: string }[];
}

export interface TenantDiscoveryRun {
  id: string;
  connection_id: string | null;
  status: import('./domain').TenantDiscoveryRunStatus;
  started_by: string;
  started_at: string | null;
  finished_at: string | null;
  /** object types this run covered; null = a full discovery */
  scope_types: import('./domain').TenantObjectType[] | null;
  progress: TenantDiscoveryProgress;
  summary: Record<string, unknown>;
  error: string | null;
  created_at: string;
}

/** One recorded change to a discovered object (`tenant_object_versions`). */
export interface TenantObjectVersion {
  id: string;
  object_id: string;
  run_id: string | null;
  object_type: import('./domain').TenantObjectType;
  object_key: string;
  display_name: string | null;
  change_kind: import('./domain').TenantObjectChangeKind;
  /** top-level `data` keys that differ between `before` and `after` */
  changed_fields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed_at: string;
}

/** A row of the current-snapshot inventory (`tenant_objects`). */
export interface TenantObject {
  id: string;
  object_type: import('./domain').TenantObjectType;
  object_key: string;
  display_name: string | null;
  data: Record<string, unknown>;
  first_seen_run_id: string | null;
  last_seen_run_id: string | null;
  discovered_at: string;
  removed_at: string | null;
}

/** The "hot" projection of a discovered user (`tenant_users`) - what the UI lists and autofill reads. */
export interface TenantUserSummary {
  id: string;
  object_id: string;
  upn: string;
  entra_id: string | null;
  display_name: string | null;
  account_type: string | null;
  account_enabled: boolean | null;
  enterprise_voice_enabled: boolean;
  line_uri: string | null;
  telephone_numbers: { number: string; category?: string }[];
  feature_types: string[];
  assigned_plans: unknown[];
  usage_location: string | null;
  department: string | null;
  job_title: string | null;
  interpreted_user_type: string | null;
  /** policy name per policy type, e.g. { TeamsCallingPolicy: 'Global' } */
  policies: Record<string, string | null>;
  when_changed: string | null;
  last_seen_run_id: string | null;
  removed_at: string | null;
  /** id of the Data Collection user linked to this tenant user, when one exists */
  discovery_user_id?: string | null;
}

export interface TenantPolicySummary {
  id: string;
  object_id: string;
  policy_type: import('./domain').TenantPolicyType;
  identity: string;
  name: string;
  is_global: boolean;
  data: Record<string, unknown>;
  last_seen_run_id: string | null;
  removed_at: string | null;
}

/**
 * A live customer-tenant sign-in, with the engineer who established it. A
 * connection may only be used by its owner or a SUPER_ADMIN — see docs/SECURITY.md.
 */
export interface TenantConnectionInfo {
  id: string;
  status: 'pending' | 'active' | 'expired' | 'closed';
  /** the customer-tenant admin account the engineer signed in as */
  upn: string | null;
  tenant_domain: string | null;
  started_at: string;
  expires_at: string | null;
  /** the Voxshift user who signed in (null if the account was since removed) */
  owner: { id: string; name: string | null; email: string } | null;
  /** true when the requesting user established this session */
  isMine: boolean;
}

/**
 * A shared phone endpoint derived from the users / resource-account snapshot:
 * a Common Area Phone account, or a phone-enabled resource account. There is no
 * Graph API for the physical device inventory (Microsoft retired it), so this is
 * "which phone endpoints exist", not hardware model / serial / firmware.
 */
export interface TenantEndpoint {
  kind: 'common_area_phone' | 'resource_account';
  name: string | null;
  upn: string | null;
  /** E.164, or null when no number is assigned */
  number: string | null;
  callingPolicy: string | null;
  ipPhonePolicy: string | null;
  enabled: boolean | null;
}

/** `GET .../tenant-discovery/summary` */
export interface TenantDiscoverySummary {
  tenant: { id: string | null; displayName: string | null; domains: string[] } | null;
  lastRun: TenantDiscoveryRun | null;
  /** the requesting user's own active session (or null) */
  activeConnection: TenantConnectionInfo | null;
  /** every active session for this customer for a SUPER_ADMIN; just the caller's own otherwise */
  activeConnections: TenantConnectionInfo[];
  /** true when the caller may run a sync on any engineer's session (SUPER_ADMIN) */
  canManageConnections: boolean;
  counts: Partial<Record<import('./domain').TenantObjectType, number>>;
  linkedDiscoveryUsers: number;
  /** per-customer Discovery settings */
  settings: { filterUsers: boolean; notifyOnComplete: boolean };
}

/* ------------------------------ Design & Build ----------------------------- */

/**
 * Live-vs-target comparison for one build_users/build_caps row, computed by
 * joining against Discovery's tenant_users/tenant_policies - the replacement
 * for the build workbook's manually-refreshed `G-*` columns.
 */
export interface BuildRowValidation {
  /** false if the UPN isn't found in the tenant at all (Discovery hasn't seen it, or it doesn't exist) */
  existsInTenant: boolean;
  /** live state from tenant_users; null when existsInTenant is false or Discovery has never run */
  enterpriseVoiceEnabled: boolean | null;
  liveLineUri: string | null;
  /** true when the row's target e164 is also the target on another build_users/build_caps/build_resource_accounts row in the tenant */
  numberConflict: boolean;
  /** each target policy whose live effective assignment differs (or is unset) */
  policyMismatches: { key: import('./domain').PolicyKey; label: string; target: string; live: string | null }[];
  /** target policy names that don't exist anywhere in tenant_policies for their type - likely a typo */
  unknownPolicies: { key: import('./domain').PolicyKey; label: string; value: string }[];
  /**
   * Rows with a policy_ids link whose target tenant_policies row still
   * exists but was renamed since - the stored `policies.<key>` name is
   * stale display text, not a broken assignment (deployment always
   * resolves the live name via the id - see worker main.ts).
   */
  renamedPolicies: { key: import('./domain').PolicyKey; label: string; storedName: string; liveName: string }[];
  /** target policy keys Discovery doesn't currently track live (see POLICY_KIND_TO_TENANT_TYPE) */
  untracked: import('./domain').PolicyKey[];
}

/** Result of POST build/validate - see BuildService.validateSite. */
export interface BuildValidateResult {
  rows: number;
  issues: number;
  /**
   * Set when some validated rows had no stored tenant_users match and a
   * live connection was available - a background tenant_discovery_runs job
   * (scope_types: ['user']) is checking just those UPNs. Poll
   * GET tenant-discovery/runs/:id and re-validate (live: false) once it
   * completes. Null when nothing needed a live check, or none was possible.
   */
  liveCheck: { runId: string } | null;
}

/** Per-site rollup shown on the Design & Build landing page. */
export interface BuildSiteRollup {
  id: string;
  sitecode: string;
  name: string | null;
  counts: { users: number; caps: number; resourceAccounts: number };
  /** rows whose computed BuildRowValidation has any issue (missing/mismatch/unknown/conflict) */
  validationIssues: number;
  lastDeployment: { id: string; mode: 'dry_run' | 'execute'; status: string; createdAt: string } | null;
}

/** Per-site rollup shown on the Deployment landing page. */
export interface DeploymentSiteRollup {
  id: string;
  sitecode: string;
  name: string | null;
  counts: { users: number; caps: number; resourceAccounts: number };
  lastDeployment: { id: string; mode: 'dry_run' | 'execute'; status: string; createdAt: string } | null;
}

/**
 * One row of a read-only deployment preview - what planIdentityRow/
 * planResourceAccountRow would produce for this row right now, with no
 * connection and no worker/queue involvement. `calls` is the raw cmdlet
 * data; `renderedCommands` is the same calls pre-rendered to PowerShell text
 * via renderCommand(), for display and for the change-recording document.
 */
export interface DeploymentPreviewRow {
  rowId: string;
  objectType: 'user' | 'cap' | 'resource_account';
  upn: string;
  calls: CmdletInvocation[];
  renderedCommands: string[];
}

/** A row from the general-purpose per-tenant file store (see FilesTable). */
export interface FileRow {
  id: string;
  category: 'deployment_change_document' | 'number_port_document';
  sourceType: string;
  sourceId: string;
  siteId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  uploadedBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
