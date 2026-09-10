import { z } from 'zod';
import { ROLES } from './rbac';
import {
  CALLER_ID_OPTIONS,
  FEATURE_AREAS,
  FEATURE_PRIORITIES,
  FEATURE_STATUSES,
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
  NUMBER_STATUSES,
  RESOURCE_ACCOUNT_KINDS,
  TENANT_OBJECT_TYPES,
  TENANT_POLICY_TYPES,
} from './domain';

export const emailSchema = z.string().email().max(320).transform((s) => s.toLowerCase().trim());

/** NIST-ish: length over complexity. */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const totpEnrolConfirmSchema = z.object({
  totp: z.string().regex(/^\d{6}$/),
});

/** Set a new password on the forced first-sign-in reset (before MFA enrolment). */
export const passwordChangeSchema = z.object({
  newPassword: passwordSchema,
});
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

export const createUserSchema = z.object({
  email: emailSchema,
  displayName: z.string().min(1).max(120),
  role: z.enum(ROLES),
  // No password: the system generates a temporary one, emails it, and forces a
  // reset on first sign-in.
  tenantIds: z.array(z.string().uuid()).optional(),
  /**
   * For a CUSTOMER user with exactly one tenant: limit them to these sites
   * (a "site contact"). Omit / empty = access to the whole customer.
   */
  siteIds: z.array(z.string().uuid()).max(500).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const inviteUserSchema = z.object({
  email: emailSchema,
  displayName: z.string().min(1).max(120),
  role: z.enum(ROLES),
  tenantId: z.string().uuid().optional(),
});

export const createTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, numbers and hyphens'),
  primaryDomain: z.string().max(253).optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const addMembershipSchema = z.object({
  userId: z.string().uuid(),
  /** Limit a CUSTOMER member to these site ids; omit / empty = whole customer. */
  siteIds: z.array(z.string().uuid()).max(500).optional(),
});

/** Change an existing member's site scope. Empty array = whole customer. */
export const updateMembershipSchema = z.object({
  siteIds: z.array(z.string().uuid()).max(500),
});

export const startConnectionSchema = z.object({
  tenantDomain: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+$/i, 'e.g. contoso.onmicrosoft.com')
    .optional(),
});

export const createDeploymentSchema = z.object({
  connectionId: z.string().uuid(),
  mode: z.enum(['dry_run', 'execute']),
  scope: z
    .object({
      sheets: z.array(z.enum(['users', 'caps', 'auto_attendants', 'call_queues', 'm365_groups'])).min(1),
      waves: z.array(z.string()).optional(),
      rowIds: z.array(z.string().uuid()).optional(),
    })
    .strict(),
});
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

/* ------------------------- Data Collection DTOs ------------------------- */

const str = (max = 400) => z.string().trim().max(max);
const optStr = (max = 400) => str(max).optional().or(z.literal(''));

/**
 * Optional link to a `discovery_sites.id`. A cleared dropdown sends '' -> null.
 * The API requires this to be set (and in scope) for site-scoped "site contact"
 * users; for whole-customer users it may be left blank.
 */
const siteIdRef = z.preprocess(
  (v) => (v === '' || v == null ? null : v),
  z.string().uuid().nullable().optional(),
);

export const discoveryGeneralSchema = z
  .object({
    migrationId: optStr(80),
    region: optStr(120),
    author: optStr(160),
    licensingModel: z.enum(LICENSING_MODELS).or(z.literal('')).optional(),
    targetGoLive: optStr(40),
    primaryContactEmail: z.string().trim().max(320).email().or(z.literal('')).optional(),
    notes: optStr(4000),
  })
  .strict();
export type DiscoveryGeneralInput = z.infer<typeof discoveryGeneralSchema>;

/**
 * Per-site overview (discovery_sites.overview). Same fields as the old
 * customer-level overview plus the assigned staff (ENGINEER / PROJECT_MANAGER
 * platform user ids). Only SUPER_ADMIN / PROJECT_MANAGER / ENGINEER may write it.
 */
export const discoverySiteOverviewSchema = discoveryGeneralSchema
  .extend({ assignedUserIds: z.array(z.string().uuid()).max(50).optional() })
  .strict();
export type DiscoverySiteOverviewInput = z.infer<typeof discoverySiteOverviewSchema>;

/** A site's unique key. Alnum, dash, dot, underscore. */
export const sitecodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, dash or underscore only');

const latitude = z.preprocess(
  (v) => (v === '' || v == null ? null : v),
  z.coerce.number().min(-90).max(90).nullable().optional(),
);
const longitude = z.preprocess(
  (v) => (v === '' || v == null ? null : v),
  z.coerce.number().min(-180).max(180).nullable().optional(),
);

export const discoverySiteSchema = z
  .object({
    sitecode: sitecodeSchema,
    name: optStr(200),
    address: optStr(500),
    country: optStr(80),
    region: optStr(120),
    latitude,
    longitude,
    paging: z.record(z.unknown()).optional(),
  })
  .strict();
export type DiscoverySiteInput = z.infer<typeof discoverySiteSchema>;

const e164ish = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^\+?[0-9]+$/, 'digits only, optional leading +');

export const discoveryNumberRangeSchema = z
  .object({
    sitecode: sitecodeSchema,
    range_start: e164ish,
    range_end: e164ish,
    kind: z.enum(NUMBER_RANGE_KINDS),
    carrier: optStr(160),
    loa_sent: z.coerce.boolean().optional(),
    loa_completed: z.coerce.boolean().optional(),
    comments: optStr(2000),
  })
  .strict();
export type DiscoveryNumberRangeInput = z.infer<typeof discoveryNumberRangeSchema>;

export const discoveryNetworkSchema = z
  .object({
    site_id: siteIdRef,
    scope: z.enum(NETWORK_SCOPES),
    subnet: str(64).min(1),
    mask: z.preprocess(
      (v) => (v === '' || v == null ? null : v),
      z.coerce.number().int().min(0).max(32).nullable().optional(),
    ),
    /** kept permissive so legacy free-text rows still save; the UI offers NETWORK_LOCATIONS */
    location: optStr(200),
    vlan_id: z.preprocess(
      (v) => (v === '' || v == null ? null : v),
      z.coerce.number().int().min(1).max(4094).nullable().optional(),
    ),
    network_type: z.preprocess(
      (v) => (v === '' ? null : v),
      z.enum(NETWORK_TYPES).nullable().optional(),
    ),
  })
  .strict();
export type DiscoveryNetworkInput = z.infer<typeof discoveryNetworkSchema>;

export const discoveryFlowSchema = z
  .object({
    site_id: siteIdRef,
    kind: z.enum(FLOW_KINDS),
    name: str(200).min(1),
    description: optStr(8000),
  })
  .strict();
export type DiscoveryFlowInput = z.infer<typeof discoveryFlowSchema>;

/* ------------------- Telephony discovery DTOs ------------------- */

const yn = z.coerce.boolean();

export const callingPolicySchema = z
  .object({
    name: str(120).min(1),
    description: optStr(500),
    allow_local: yn.optional(),
    allow_national: yn.optional(),
    allow_international: yn.optional(),
    allow_service: yn.optional(),
    allow_premium: yn.optional(),
  })
  .strict();
export type CallingPolicyInput = z.infer<typeof callingPolicySchema>;

const blankToNull = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' ? null : v), inner.nullable().optional());

const callerId = blankToNull(z.enum(CALLER_ID_OPTIONS));
/** '' from a cleared dropdown is treated as null. */
const refId = blankToNull(z.string().uuid());

export const discoveryUserSchema = z
  .object({
    site_id: siteIdRef,
    upn: emailSchema,
    display_name: optStr(160),
    calling_policy_id: refId,
    caller_id: callerId,
    voicemail_enabled: yn.optional(),
    voicemail_language: optStr(80),
    requires_handset: yn.optional(),
    handset_model: optStr(120),
    access_port_id: optStr(80),
    comments: optStr(2000),
    /** number the customer asked for; free text, reconciled in Design & Build */
    requested_number: optStr(40),
    /** assign / move / clear this holder's number in the same call */
    phone_number_id: refId,
  })
  .strict();
export type DiscoveryUserInput = z.infer<typeof discoveryUserSchema>;

/* ---------- Import from Excel: bulk-create users from a spreadsheet ---------- */

/** Tolerant yes/no/true/1/x -> boolean; anything else -> undefined. */
const ynLoose = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  const t = String(v ?? '').trim().toLowerCase();
  if (['y', 'yes', 'true', '1', 'x', 'enabled', 'on'].includes(t)) return true;
  if (['n', 'no', 'false', '0', 'disabled', 'off', ''].includes(t)) return false;
  return undefined;
}, z.boolean().optional());

const callerIdLoose = z.preprocess(
  (v) => {
    const t = String(v ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    return t === '' ? undefined : t;
  },
  z.enum(CALLER_ID_OPTIONS).optional(),
);

/** One parsed spreadsheet row. `calling_policy` is a policy *name* (resolved
 * server-side); `requested_number` is free text. */
export const importUserRowSchema = z
  .object({
    upn: emailSchema,
    requested_number: str(40).optional().or(z.literal('')),
    display_name: optStr(160),
    calling_policy: optStr(120),
    caller_id: callerIdLoose,
    voicemail_enabled: ynLoose,
    voicemail_language: optStr(80),
    requires_handset: ynLoose,
    handset_model: optStr(120),
    access_port_id: optStr(80),
    comments: optStr(2000),
  })
  .strict();
export type ImportUserRow = z.infer<typeof importUserRowSchema>;

export const usersImportSchema = z
  .object({
    site_id: z.string().uuid(),
    rows: z.array(importUserRowSchema).min(1).max(2000),
  })
  .strict();
export type UsersImportInput = z.infer<typeof usersImportSchema>;

export const discoveryCapSchema = z
  .object({
    site_id: siteIdRef,
    display_name: str(160).min(1),
    upn: optStr(320),
    device_model: optStr(120),
    calling_policy_id: refId,
    caller_id: callerId,
    access_port_id: optStr(80),
    comments: optStr(2000),
    phone_number_id: refId,
  })
  .strict();
export type DiscoveryCapInput = z.infer<typeof discoveryCapSchema>;

export const discoveryResourceAccountSchema = z
  .object({
    site_id: siteIdRef,
    name: str(160).min(1),
    kind: z.enum(RESOURCE_ACCOUNT_KINDS),
    directory_entry: optStr(160),
    business_hours: optStr(400),
    who_answers: optStr(2000),
    ooh_action: optStr(1000),
    exception_conditions: optStr(2000),
    exception_action: optStr(1000),
    holiday: optStr(1000),
    advanced_features: optStr(4000),
    comments: optStr(2000),
  })
  .strict();
export type DiscoveryResourceAccountInput = z.infer<typeof discoveryResourceAccountSchema>;

/** Attach / detach a number from a resource account (which can hold several). */
export const resourceAccountNumberSchema = z
  .object({ phone_number_id: z.string().uuid() })
  .strict();

/** Manually flip a free number to/from 'reserved' (e.g. held for porting). */
export const numberReserveSchema = z.object({ reserved: z.boolean() }).strict();

/**
 * Link every not-yet-linked Data Collection user for a site to the tenant user
 * with the same UPN (from the last Discovery run). Idempotent.
 */
export const relinkUsersSchema = z.object({ site_id: z.string().uuid() }).strict();
export type RelinkUsersInput = z.infer<typeof relinkUsersSchema>;

/* ------------------- Data Collection list queries ------------------- */

/**
 * Query string for the paginated Data Collection list endpoints
 * (`GET .../users`, `.../numbers`, etc). Everything is optional; `page`/`limit`
 * default. `siteId` narrows to one site (ignored/clamped for site contacts).
 */
export const discoveryListQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  q: z.string().trim().max(160).optional(),
  status: z.enum(NUMBER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DiscoveryListQuery = z.infer<typeof discoveryListQuerySchema>;

/* -------------------------- Feature requests -------------------------- */

const featureText = (min: number, max = 6000) => z.string().trim().min(min).max(max);

/**
 * A new feature request. The long fields feed the "prompt for Claude" the board
 * generates, so the client guidance nudges towards Claude prompting best
 * practice: state the goal and the pain, describe the desired end state, give a
 * concrete example, list acceptance criteria, and call out anything off-limits.
 */
export const featureRequestCreateSchema = z
  .object({
    title: z.string().trim().min(6, 'Give a short, specific title').max(160),
    area: z.enum(FEATURE_AREAS),
    priority: z.enum(FEATURE_PRIORITIES).default('medium'),
    problem: featureText(20),
    proposal: featureText(20),
    current_behavior: optStr(6000),
    examples: optStr(6000),
    acceptance: optStr(6000),
    constraints: optStr(6000),
    affected_roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  })
  .strict();
export type FeatureRequestCreateInput = z.infer<typeof featureRequestCreateSchema>;

/** Board edits: any field, plus the workflow `status` and a `decision_note`. */
export const featureRequestUpdateSchema = z
  .object({
    title: z.string().trim().min(6).max(160).optional(),
    area: z.enum(FEATURE_AREAS).optional(),
    priority: z.enum(FEATURE_PRIORITIES).optional(),
    status: z.enum(FEATURE_STATUSES).optional(),
    problem: featureText(20).optional(),
    proposal: featureText(20).optional(),
    current_behavior: optStr(6000),
    examples: optStr(6000),
    acceptance: optStr(6000),
    constraints: optStr(6000),
    affected_roles: z.array(z.enum(ROLES)).max(ROLES.length).optional(),
    decision_note: optStr(2000),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type FeatureRequestUpdateInput = z.infer<typeof featureRequestUpdateSchema>;

/* ------------------ Discovery (live customer-tenant inventory) ------------------ */

/**
 * Kick off a discovery run over an `active` tenant connection. `scopeTypes`
 * limits the run to part of the tenant (a whole step's types, or individual
 * ones); omit it for a full discovery.
 */
export const tenantDiscoveryStartSchema = z
  .object({
    connectionId: z.string().uuid(),
    scopeTypes: z.array(z.enum(TENANT_OBJECT_TYPES)).min(1).max(TENANT_OBJECT_TYPES.length).optional(),
    /** also sync AccountEnabled = false accounts (default: skip them) */
    includeDisabled: z.boolean().optional(),
    /** also sync Guest / IneligibleUser and users not licensed for Teams (default: skip) */
    includeUnlicensed: z.boolean().optional(),
  })
  .strict();
export type TenantDiscoveryStartInput = z.infer<typeof tenantDiscoveryStartSchema>;

/** Per-customer Discovery settings (`PATCH .../tenant-discovery/settings`). */
export const tenantDiscoverySettingsSchema = z
  .object({
    /** when true (default), runs store only User accounts licensed for Teams */
    filterUsers: z.boolean(),
  })
  .strict();
export type TenantDiscoverySettingsInput = z.infer<typeof tenantDiscoverySettingsSchema>;

/** Query string for the paginated inventory lists (`GET .../objects`, `.../users`). */
export const tenantObjectsQuerySchema = z.object({
  type: z.enum(TENANT_OBJECT_TYPES).optional(),
  policyType: z.enum(TENANT_POLICY_TYPES).optional(),
  q: z.string().trim().max(160).optional(),
  includeRemoved: z
    .preprocess((v) => v === 'true' || v === true, z.boolean())
    .optional(),
  /** users only: Enterprise-Voice-enabled accounts only */
  ev: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional(),
  /** users only: Get-CsOnlineUser AccountType (User, ResourceAccount, Guest, IneligibleUser, SfBOnPremUser) */
  accountType: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TenantObjectsQuery = z.infer<typeof tenantObjectsQuerySchema>;

/** Exact-UPN lookup used by the Data Collection add-user autofill. */
export const tenantUserLookupSchema = z.object({
  upn: z.string().trim().min(3).max(320),
});
export type TenantUserLookupQuery = z.infer<typeof tenantUserLookupSchema>;

/**
 * Bulk-create Data Collection users from the discovered tenant users that are
 * not already captured (matched on lower(upn)).
 */
export const tenantUsersImportSchema = z
  .object({
    siteId: z.string().uuid(),
    onlyEnterpriseVoice: z.boolean().default(true),
    calling_policy_id: z.string().uuid().nullable().optional(),
  })
  .strict();
export type TenantUsersImportInput = z.infer<typeof tenantUsersImportSchema>;
