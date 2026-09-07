export * from './rbac';
export * from './domain';
export * from './dto';

/** Header the web app sends to select the active tenant for `/t/:tenantId/*`. */
export const TENANT_HEADER = 'x-tenant-id';

/** Shape of the authenticated principal returned by `GET /auth/me`. */
export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: import('./rbac').Role;
  totpEnrolled: boolean;
  tenants: { id: string; slug: string; name: string }[];
}
