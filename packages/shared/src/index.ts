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
