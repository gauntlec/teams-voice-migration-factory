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
}

export interface TenantContext {
  id: string;
  slug: string;
  name: string;
  schema: string;
}

export interface AppRequest extends Request {
  user?: AuthedUser;
  tenant?: TenantContext;
}
