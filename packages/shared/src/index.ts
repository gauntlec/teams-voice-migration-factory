export * from './rbac';
export * from './domain';
export * from './dto';
export * from './email';

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

/** `GET .../tenant-discovery/summary` */
export interface TenantDiscoverySummary {
  tenant: { id: string | null; displayName: string | null; domains: string[] } | null;
  lastRun: TenantDiscoveryRun | null;
  activeConnection: { id: string; upn: string | null; status: string; expires_at: string | null } | null;
  counts: Partial<Record<import('./domain').TenantObjectType, number>>;
  linkedDiscoveryUsers: number;
  /** per-customer Discovery settings */
  settings: { filterUsers: boolean };
}
