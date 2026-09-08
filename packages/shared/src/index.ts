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
