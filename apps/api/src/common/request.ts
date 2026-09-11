import type { Request } from 'express';
import type { Role } from '@tvmf/shared';

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  totpEnrolled: boolean;
  /** true when the bearer token is a limited "enrol TOTP" token */
  enrolOnly: boolean;
  /** true when the bearer token is a limited "forced password reset" token */
  pwresetOnly: boolean;
}

export interface TenantContext {
  id: string;
  slug: string;
  name: string;
  schema: string;
  /**
   * null  -> whole-customer access (SUPER_ADMIN, ENGINEER, unscoped CUSTOMER).
   * array -> a "site contact": limited to these discovery_sites.id values.
   * Set by TenantGuard; enforced by the Data Collection services.
   */
  siteScope: string[] | null;
  /** true -> no write cmdlet may ever reach this customer's live Microsoft Teams tenant - see docs/SECURITY.md. */
  teamsReadOnly: boolean;
}

export interface AppRequest extends Request {
  user?: AuthedUser;
  tenant?: TenantContext;
}
