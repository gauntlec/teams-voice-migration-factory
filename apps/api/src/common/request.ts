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
  /**
   * Set when this "user" is an AI agent acting through the agent API (see agent-actor.ts): events it makes
   * are attributed to the agent (not a person), and it never has an email or an account.
   */
  agent?: { id: string; name: string };
  /** Set when this "user" is a monitoring alert source or the inbound mailbox (see intake-actor.ts): events are "system" ones, and it has no account or email. */
  system?: { id: string; name: string };
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
  /** Managed Services is switched on: the customer can raise service requests. */
  managedServices: boolean;
}

/** An AI agent authenticated by its token (see AgentAuthGuard). */
export interface AgentPrincipal {
  agentId: string;
  tokenId: string;
  name: string;
  kind: import('@tvmf/shared').AgentKind;
  scopes: import('@tvmf/shared').AgentScope[];
  /** The areas this assistant may work in. */
  worksOn: import('@tvmf/shared').AgentDomain[];
}

/** A monitoring alert source authenticated by its token (see IntakeAuthGuard). */
export interface IntakePrincipal {
  sourceId: string;
  tenantId: string;
  name: string;
  kind: import('@tvmf/shared').IntakeKind;
  config: import('@tvmf/shared').IntakeConfig;
}

export interface AppRequest extends Request {
  intake?: IntakePrincipal;
  user?: AuthedUser;
  agent?: AgentPrincipal;
  tenant?: TenantContext;
}
