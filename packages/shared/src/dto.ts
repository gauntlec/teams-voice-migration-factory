import { z } from 'zod';
import { ROLES } from './rbac';
import {
  BUG_SEVERITIES,
  BUG_STATUSES,
  BUSY_ON_BUSY_OPTIONS,
  CALLER_ID_OPTIONS,
  CALL_FORWARDING_TYPES,
  CALL_GROUP_ORDERS,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  CALL_TARGET_TYPES,
  FEATURE_AREAS,
  FEATURE_PRIORITIES,
  FEATURE_STATUSES,
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
  NUMBER_STATUSES,
  NUMBER_TYPES,
  RESOURCE_ACCOUNT_KINDS,
  TENANT_OBJECT_TYPES,
  TENANT_POLICY_TYPES,
  VOICEMAIL_PROMPT_LANGUAGE_CODES,
  normalizeVoicemailLanguage,
} from './domain';
import { HEX_COLOR_RE } from './color';

export const emailSchema = z.string().email().max(320).transform((s) => s.toLowerCase().trim());

/**
 * A Teams UPN. Zod's built-in .email() rejects non-ASCII local parts (e.g.
 * "Taïs.DeWinter@..."), which real-world M365 UPNs derived from a person's
 * name legitimately contain. Deliberately as tolerant as the browser-side
 * import preview's own check, so the server never disagrees with what the
 * user was shown as "Ready".
 */
export const upnSchema = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid UPN')
  .transform((s) => s.toLowerCase());

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
  /**
   * ENGINEER/PROJECT_MANAGER only - explicit MSP-branding override, used
   * only as a fallback when the user's own email domain doesn't match any
   * MSP's domain list. See Me.mspBranding / auth.service.ts's resolveMspBranding.
   */
  mspId: z.string().uuid().nullable().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** The only field an existing user's MSP override can be changed through - see PATCH /users/:id/msp. */
export const updateUserMspSchema = z.object({ mspId: z.string().uuid().nullable() }).strict();
export type UpdateUserMspInput = z.infer<typeof updateUserMspSchema>;

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

/** Toggles the per-customer safeguard that blocks all writes to the customer's live Microsoft Teams tenant - see docs/SECURITY.md. */
export const updateTenantSchema = z.object({ teamsReadOnly: z.boolean() }).strict();
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/** Logo upload is a separate multipart route - this is just the color half of branding. */
export const updateTenantBrandingSchema = z
  .object({ accentColor: z.string().regex(HEX_COLOR_RE, 'must be a #rrggbb hex color') })
  .strict();
export type UpdateTenantBrandingInput = z.infer<typeof updateTenantBrandingSchema>;

/** A single email domain, lowercased/trimmed - server-side dedupe happens in MspsService. */
const mspDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((s) => s.toLowerCase().replace(/^@/, ''));

export const createMspSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, numbers and hyphens'),
  domains: z.array(mspDomainSchema).max(50).optional(),
});
export type CreateMspInput = z.infer<typeof createMspSchema>;

export const updateMspSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    domains: z.array(mspDomainSchema).max(50).optional(),
  })
  .strict();
export type UpdateMspInput = z.infer<typeof updateMspSchema>;

/** Same shape as updateTenantBrandingSchema - logo upload is a separate multipart route. */
export const updateMspBrandingSchema = z
  .object({ accentColor: z.string().regex(HEX_COLOR_RE, 'must be a #rrggbb hex color') })
  .strict();
export type UpdateMspBrandingInput = z.infer<typeof updateMspBrandingSchema>;

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
      /** Every deployment run acts on one site's Build rows at a time. */
      siteId: z.string().uuid(),
      sheets: z
        .array(z.enum(['users', 'caps', 'resource_accounts', 'auto_attendants', 'call_queues', 'm365_groups']))
        .min(1),
      waves: z.array(z.string()).optional(),
      rowIds: z.array(z.string().uuid()).optional(),
    })
    .strict(),
});
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

/**
 * Express's default query parser turns `?sheets=a,b,c` into the single
 * string "a,b,c", not an array - only repeated keys (`?sheets=a&sheets=b`)
 * parse as an array. Query-string array params need to accept either shape;
 * `arraySchema` is the fully-built target schema (with its own .min()/etc).
 */
const queryArray = <T extends z.ZodTypeAny>(arraySchema: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), arraySchema);

/**
 * Read-only "what would this deploy right now" preview - no connection, no
 * worker/queue involvement. Deliberately excludes auto_attendants/m365_groups:
 * no worker code path handles those sheets yet (see planIdentityRow/
 * planResourceAccountRow/planCallQueueRow and handleDeploymentRun), so
 * previewing them would be misleading. call_queues is planned
 * (planCallQueueRow) but not in the default list, matching resource_accounts'
 * own opt-in-by-caller shape.
 */
export const deploymentPreviewQuerySchema = z.object({
  siteId: z.string().uuid(),
  sheets: queryArray(z.array(z.enum(['users', 'caps', 'resource_accounts', 'call_queues'])).min(1)).default([
    'users',
    'caps',
    'resource_accounts',
  ]),
  rowIds: queryArray(z.array(z.string().uuid())).optional(),
});
export type DeploymentPreviewQuery = z.infer<typeof deploymentPreviewQuerySchema>;

/** rowIds omitted = generate for the whole site. */
export const generateDeploymentDocumentSchema = z.object({
  rowIds: z.array(z.string().uuid()).optional(),
});
export type GenerateDeploymentDocumentInput = z.infer<typeof generateDeploymentDocumentSchema>;

/* ------------------------- Data Collection DTOs ------------------------- */

const str = (max = 400) => z.string().trim().max(max);
const optStr = (max = 400) => str(max).optional().or(z.literal(''));

/**
 * Shared shape for every "bulk edit N selected rows" action (Design &
 * Build's Users/CAPs, Data Collection's Users/CAPs, …): a bounded list of
 * row ids plus a strict partial patch over just the fields that entity
 * allows to bulk-set. One definition of the id-list bound, so raising or
 * lowering how many rows a bulk edit can touch at once changes for every
 * module together.
 */
const bulkPatchSchema = <T extends z.ZodRawShape>(fields: T) =>
  z
    .object({
      ids: z.array(z.string().uuid()).min(1).max(500),
      patch: z.object(fields).strict(),
    })
    .strict();

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
  .extend({
    assignedUserIds: z.array(z.string().uuid()).max(50).optional(),
    /** Days between number-port document reminder emails for this site (default 7). */
    portDocReminderDays: z.coerce.number().int().min(1).max(90).optional(),
  })
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

/* --------------------- Number-port document collection --------------------- */
// "LOA Data Collection and Tracking" - a number-port request's document
// checklist. See docs on the three-tier model: port_document_types (global
// catalog) -> site_port_document_types (per-site enabled subset) ->
// number_port_request_items (per-request checklist, picked from the site's
// enabled subset).

/** Global catalog entry - admin/PM/Engineer only (discovery:sites:manage). */
export const portDocumentTypeSchema = z
  .object({
    key: str(60).regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores only'),
    label: str(160),
    ordinal: z.coerce.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type PortDocumentTypeInput = z.infer<typeof portDocumentTypeSchema>;

/** Toggle one catalog entry on/off for a site. */
export const sitePortDocumentTypeSchema = z
  .object({
    document_type_id: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();
export type SitePortDocumentTypeInput = z.infer<typeof sitePortDocumentTypeSchema>;

/**
 * PM/Engineer builds a request's checklist by replacing its whole item set in
 * one call - picked from the site's enabled catalog subset, each optionally
 * carrying a note (e.g. "authorized signer: Jane Doe" for the ID item).
 */
export const numberPortRequestItemsSchema = z
  .object({
    items: z
      .array(
        z.object({
          document_type_id: z.string().uuid(),
          note: optStr(500),
        }),
      )
      .max(50),
  })
  .strict();
export type NumberPortRequestItemsInput = z.infer<typeof numberPortRequestItemsSchema>;

/** PM/Engineer marks one uploaded item as no good and asks the customer to redo it. */
export const numberPortItemRejectSchema = z
  .object({
    reason: str(500),
  })
  .strict();
export type NumberPortItemRejectInput = z.infer<typeof numberPortItemRejectSchema>;

/** PM/Engineer marks one item as not needed after all, without the customer uploading anything. */
export const numberPortItemWaiveSchema = z
  .object({
    waived: z.boolean(),
  })
  .strict();
export type NumberPortItemWaiveInput = z.infer<typeof numberPortItemWaiveSchema>;

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
/**
 * Voicemail language, stored as the culture code Teams' PromptLanguage wants.
 * Accepts a code in any case or a common English name (see
 * normalizeVoicemailLanguage) so Excel imports and old free-text values still
 * land; anything unrecognised is rejected rather than stored undeployable.
 */
const voicemailLanguage = z.preprocess(
  (v) => (v == null || v === '' ? null : (normalizeVoicemailLanguage(v) ?? v)),
  z
    .enum(VOICEMAIL_PROMPT_LANGUAGE_CODES, {
      errorMap: () => ({ message: 'Voicemail language must be one Teams supports, e.g. en-US or "English (United Kingdom)"' }),
    })
    .nullable()
    .optional(),
);

export const discoveryUserSchema = z
  .object({
    site_id: siteIdRef,
    upn: upnSchema,
    display_name: optStr(160),
    calling_policy_id: refId,
    caller_id: callerId,
    voicemail_enabled: yn.optional(),
    voicemail_language: voicemailLanguage,
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
    upn: upnSchema,
    requested_number: str(40).optional().or(z.literal('')),
    display_name: optStr(160),
    calling_policy: optStr(120),
    caller_id: callerIdLoose,
    voicemail_enabled: ynLoose,
    voicemail_language: voicemailLanguage,
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

/**
 * Bulk-edit for discovery_users/discovery_caps - the same patch applied to
 * many rows at once, the Data Collection counterpart to
 * buildBulkPatchSchema above (both built on the shared bulkPatchSchema).
 * `site_id`, `upn`/`display_name` and `phone_number_id` are excluded for the
 * same reason as Design & Build's: they're per-row-unique identifiers, so
 * bulk-setting the same value on every selected row would be destructive
 * (moving everyone to one site, giving them all the same name, or claiming
 * the same phone number for each of them) rather than a real bulk edit.
 * Users additionally excludes `requested_number` - a customer's requested
 * number is specific to that one person.
 */
const { site_id: _bulkUserSiteId, upn: _bulkUserUpn, display_name: _bulkUserName, requested_number: _bulkUserReqNum, phone_number_id: _bulkUserPhoneId, ...discoveryUserBulkWritable } = discoveryUserSchema.shape;
export const discoveryUserBulkPatchSchema = bulkPatchSchema(discoveryUserBulkWritable);
export type DiscoveryUserBulkPatchInput = z.infer<typeof discoveryUserBulkPatchSchema>;

const { site_id: _bulkCapSiteId, upn: _bulkCapUpn, display_name: _bulkCapName, phone_number_id: _bulkCapPhoneId, ...discoveryCapBulkWritable } = discoveryCapSchema.shape;
export const discoveryCapBulkPatchSchema = bulkPatchSchema(discoveryCapBulkWritable);
export type DiscoveryCapBulkPatchInput = z.infer<typeof discoveryCapBulkPatchSchema>;

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

/* ---------------------------- Bug reports ---------------------------- */
// Reuses FEATURE_AREAS for `area` - "which part of the platform" is the same
// question for a bug as for a feature request, no need for a second list.

const bugText = (min: number, max = 6000) => z.string().trim().min(min).max(max);

export const bugReportCreateSchema = z
  .object({
    title: z.string().trim().min(6, 'Give a short, specific title').max(160),
    area: z.enum(FEATURE_AREAS),
    severity: z.enum(BUG_SEVERITIES).default('medium'),
    steps_to_reproduce: bugText(10),
    expected_behavior: bugText(5),
    actual_behavior: bugText(5),
    affected_customer: optStr(160),
    environment: optStr(500),
  })
  .strict();
export type BugReportCreateInput = z.infer<typeof bugReportCreateSchema>;

/** Board edits: any field, plus the workflow `status` and a `resolution_note`. */
export const bugReportUpdateSchema = z
  .object({
    title: z.string().trim().min(6).max(160).optional(),
    area: z.enum(FEATURE_AREAS).optional(),
    severity: z.enum(BUG_SEVERITIES).optional(),
    status: z.enum(BUG_STATUSES).optional(),
    steps_to_reproduce: bugText(10).optional(),
    expected_behavior: bugText(5).optional(),
    actual_behavior: bugText(5).optional(),
    affected_customer: optStr(160),
    environment: optStr(500),
    resolution_note: optStr(2000),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type BugReportUpdateInput = z.infer<typeof bugReportUpdateSchema>;

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
    filterUsers: z.boolean().optional(),
    /** when true (default), email the person who started a run when it finishes */
    notifyOnComplete: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.filterUsers !== undefined || v.notifyOnComplete !== undefined, {
    message: 'provide at least one setting to update',
  });
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

/* ------------------------- Design & Build DTOs ------------------------- */
/* Every build_* row is reached through a site workspace (see docs/DATA-MODEL.md). */

const policyMap = z.record(z.string(), z.string().nullable()).optional();
/** Picker submits a tenant_policies.id per PolicyKey - see BuildService.resolvePolicyIds. */
const policyIdMap = z.record(z.string(), z.string().uuid().nullable()).optional();
/** RecordDialog's `type: 'select'` sends '' for an untouched/cleared dropdown - treat as null, not a validation error. */
const numberType = blankToNull(z.enum(NUMBER_TYPES));

/**
 * Structured shape for build_users/build_caps' call_forwarding jsonb -
 * mirrors Set-CsUserCallingSettings' Forwarding/Unanswered/BusyOnBusy
 * settings groups exactly (see planIdentityRow in deployment.ts).
 */
const callForwardingSchema = z
  .object({
    forwarding: z
      .object({
        enabled: z.boolean(),
        type: z.enum(CALL_FORWARDING_TYPES).optional(),
        targetType: z.enum(CALL_TARGET_TYPES).optional(),
        target: optStr(200),
      })
      .strict()
      .optional(),
    unanswered: z
      .object({
        enabled: z.boolean(),
        // seconds, per Learn's allowed range/increments (5-60s)
        delaySeconds: z.number().int().min(5).max(60).optional(),
        targetType: z.enum(CALL_TARGET_TYPES).optional(),
        target: optStr(200),
      })
      .strict()
      .optional(),
    busyOnBusy: z.enum(BUSY_ON_BUSY_OPTIONS).optional(),
  })
  .strict()
  .optional();

/** build_users/build_caps' pickup_group jsonb - Set-CsUserCallingSettings' CallGroup settings group. */
const pickupGroupSchema = z
  .object({
    order: z.enum(CALL_GROUP_ORDERS),
    targets: z.array(str(200)).max(25),
  })
  .strict()
  .optional();

/** One entry of build_users/build_caps' delegates jsonb array - New-CsUserCallingDelegate's own parameters. */
const delegateSchema = z.object({
  delegateUpn: str(200),
  makeCalls: z.boolean(),
  receiveCalls: z.boolean(),
  manageSettings: z.boolean(),
  pickUpHeldCalls: z.boolean(),
  joinActiveCalls: z.boolean(),
});
const delegatesSchema = z.array(delegateSchema).max(25).optional();

/**
 * Fields writable on a build_users/build_caps row beyond the natural key
 * (site_id/upn). Shared between create and patch - the Add dialog and the Edit
 * dialog show the same field set (see RecordDialog), so both must accept it.
 */
const buildIdentityWritable = {
  did: optStr(40),
  ext: optStr(20),
  number_type: numberType,
  revoke_ev: z.boolean().optional(),
  hold_uri: optStr(120),
  action: optStr(80),
  migration_wave: optStr(80),
  policies: policyMap,
  policy_ids: policyIdMap,
  // The Set-CsOnlineVoicemailUserSettings target - language is validated as
  // a Teams culture code here, so it's never stored in a form deployment
  // would then be rejected on.
  voicemail: z.object({ enabled: z.boolean().nullable().optional(), language: voicemailLanguage }).optional(),
  call_forwarding: callForwardingSchema,
  delegates: delegatesSchema,
  pickup_group: pickupGroupSchema,
  comments: optStr(2000),
  hidden: z.boolean().optional(),
  /** assign / move / clear this row's number in the same call - null clears it */
  phone_number_id: refId,
};

export const buildIdentityCreateSchema = z
  .object({ site_id: z.string().uuid(), upn: upnSchema, ...buildIdentityWritable })
  .strict();
export type BuildIdentityCreateInput = z.infer<typeof buildIdentityCreateSchema>;

export const buildIdentityPatchSchema = z.object({ upn: upnSchema.optional(), ...buildIdentityWritable }).strict();
export type BuildIdentityPatchInput = z.infer<typeof buildIdentityPatchSchema>;

/**
 * Bulk-edit for build_users/build_caps: the same patch applied to many rows
 * at once. `upn`, `did` and `phone_number_id` are deliberately excluded -
 * they're per-row-unique identifiers, so applying the same value to
 * hundreds of rows would be destructive (duplicate UPNs, the same DID text,
 * or the same specific phone number claimed by every selected row) rather
 * than a real bulk operation.
 */
const { did: _bulkDid, phone_number_id: _bulkPhoneNumberId, ...buildBulkIdentityWritable } = buildIdentityWritable;
export const buildBulkPatchSchema = bulkPatchSchema(buildBulkIdentityWritable);
export type BuildBulkPatchInput = z.infer<typeof buildBulkPatchSchema>;

const buildCapWritable = {
  function: optStr(80),
  display_name: optStr(160),
  phone_model: optStr(120),
  device_config_profile: optStr(160),
  mac_address: optStr(40),
  serial_number: optStr(80),
  phone_location: optStr(160),
  lan_jack: optStr(80),
};

export const buildCapCreateSchema = buildIdentityCreateSchema.extend(buildCapWritable);
export type BuildCapCreateInput = z.infer<typeof buildCapCreateSchema>;

export const buildCapPatchSchema = buildIdentityPatchSchema.extend(buildCapWritable);
export type BuildCapPatchInput = z.infer<typeof buildCapPatchSchema>;

/** Bulk-seed build_users/build_caps from that site's discovery_users/discovery_caps. Idempotent. */
export const buildPopulateSchema = z.object({ site_id: z.string().uuid() }).strict();
export type BuildPopulateInput = z.infer<typeof buildPopulateSchema>;

/**
 * `live: false` on the automatic re-check after a targeted live check
 * completes - recomputes validation from the now-fresher data without
 * triggering another live check (see BuildService.validateSite).
 */
export const buildValidateSchema = buildPopulateSchema.extend({ live: z.boolean().optional() }).strict();
export type BuildValidateInput = z.infer<typeof buildValidateSchema>;

const buildResourceAccountWritable = {
  location_id: optStr(80),
  number_type: numberType,
  voice_routing_policy: optStr(160),
  /** picker submits a tenant_policies.id - see BuildService.resolvePolicyIds */
  voice_routing_policy_id: refId,
  /** assign / move / clear this account's number in the same call - null clears it */
  phone_number_id: refId,
  /**
   * Confirms New-CsOnlineApplicationInstance has been run and the account
   * licensed (a manual step - see docs/DEPLOYMENT.md) so the number/policy
   * phase can proceed. The engineer flips this after running the generated
   * script; there's no live way to detect it automatically.
   */
  created: z.boolean().optional(),
};

export const buildResourceAccountCreateSchema = z
  .object({
    site_id: z.string().uuid(),
    display_name: str(160).min(1),
    kind: z.enum(RESOURCE_ACCOUNT_KINDS),
    upn: upnSchema.optional(),
    ...buildResourceAccountWritable,
  })
  .strict();
export type BuildResourceAccountCreateInput = z.infer<typeof buildResourceAccountCreateSchema>;

export const buildResourceAccountPatchSchema = z
  .object({
    upn: upnSchema.optional(),
    display_name: optStr(160),
    kind: blankToNull(z.enum(RESOURCE_ACCOUNT_KINDS)),
    ...buildResourceAccountWritable,
  })
  .strict();
export type BuildResourceAccountPatchInput = z.infer<typeof buildResourceAccountPatchSchema>;

/**
 * build_call_queues' overflow/timeout jsonb - Set-CsCallQueue's
 * Overflow/Timeout parameter groups. `target` is a Guid, 'tel:' number, or
 * group id depending on `action` (see Set-CsCallQueue's own docs) - not
 * validated further here, same "trust the cmdlet to reject a bad value"
 * approach as call_forwarding's target fields.
 */
const callQueueActionSchema = (actions: readonly [string, ...string[]]) =>
  z
    .object({
      action: z.enum(actions).optional(),
      threshold: z.number().int().min(0).max(2700).optional(),
      target: optStr(200),
    })
    .strict()
    .optional();

const buildCallQueueWritable = {
  routing_method: blankToNull(z.enum(CALL_QUEUE_ROUTING_METHODS)),
  agent_alert_time: z.number().int().min(15).max(180).optional(),
  presence_based_routing: z.boolean().optional(),
  /** Agent UPNs - resolved to Entra object GUIDs at deploy time (Set-CsCallQueue -Users needs GUIDs). */
  agents: z.array(str(200)).max(200).optional(),
  overflow: callQueueActionSchema(CALL_QUEUE_OVERFLOW_ACTIONS),
  timeout: callQueueActionSchema(CALL_QUEUE_TIMEOUT_ACTIONS),
  /** Required by Set-CsCallQueue when overflow/timeout action is SharedVoicemail - checked in BuildService. */
  language_id: optStr(20),
  /** build_resource_accounts.id array - which RA(s)/phone numbers present this queue. */
  resource_accounts: z.array(z.string().uuid()).max(10).optional(),
  notes: optStr(2000),
};

export const buildCallQueueCreateSchema = z
  .object({ site_id: z.string().uuid(), name: str(160).min(1), ...buildCallQueueWritable })
  .strict();
export type BuildCallQueueCreateInput = z.infer<typeof buildCallQueueCreateSchema>;

export const buildCallQueuePatchSchema = z.object({ name: optStr(160), ...buildCallQueueWritable }).strict();
export type BuildCallQueuePatchInput = z.infer<typeof buildCallQueuePatchSchema>;

/**
 * build_auto_attendants' narrative-only fields, carried through from
 * discovery_resource_accounts by Populate (see BuildService.populateResourceAccounts) -
 * no cmdlet planning reads these yet, same deliberate cut as the rest of
 * this project's Auto Attendant scope.
 */
const buildAutoAttendantWritable = {
  business_hours: optStr(400),
  ooh_action: optStr(400),
  holiday: optStr(400),
  advanced_features: optStr(400),
  notes: optStr(2000),
};

export const buildAutoAttendantCreateSchema = z
  .object({ site_id: z.string().uuid(), name: str(160).min(1), ...buildAutoAttendantWritable })
  .strict();
export type BuildAutoAttendantCreateInput = z.infer<typeof buildAutoAttendantCreateSchema>;

export const buildAutoAttendantPatchSchema = z.object({ name: optStr(160), ...buildAutoAttendantWritable }).strict();
export type BuildAutoAttendantPatchInput = z.infer<typeof buildAutoAttendantPatchSchema>;

/**
 * Per site: which real tenant_policies row a Data Collection generic
 * calling-policy catalog entry ("International", "Standard", …) resolves to
 * for THIS site - see BuildService.assertCallingPoliciesMapped, which blocks
 * Populate until every catalog entry actually in use has one of these.
 */
export const callingPolicySiteMapSetSchema = z
  .object({
    site_id: z.string().uuid(),
    discovery_calling_policy_id: z.string().uuid(),
    tenant_policy_id: z.string().uuid(),
  })
  .strict();
export type CallingPolicySiteMapSetInput = z.infer<typeof callingPolicySiteMapSetSchema>;

/**
 * A named, reusable preset of policy targets + voicemail defaults for Users
 * or CAPs on one site ("Standard User Template") - the one marked
 * `is_default` seeds every new row Populate creates for that site+kind;
 * any template can also be applied on demand to already-populated rows.
 */
export const buildTemplateCreateSchema = z
  .object({
    site_id: z.string().uuid(),
    kind: z.enum(['user', 'cap']),
    name: str(160).min(1),
    policy_ids: policyIdMap,
    voicemail_enabled: z.boolean().nullable().optional(),
    voicemail_language: voicemailLanguage,
    is_default: z.boolean().optional(),
  })
  .strict();
export type BuildTemplateCreateInput = z.infer<typeof buildTemplateCreateSchema>;

export const buildTemplatePatchSchema = buildTemplateCreateSchema.partial().strict();
export type BuildTemplatePatchInput = z.infer<typeof buildTemplatePatchSchema>;

/** Apply one template's policy_ids/voicemail to a set of already-populated rows. */
export const buildTemplateApplySchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();
export type BuildTemplateApplyInput = z.infer<typeof buildTemplateApplySchema>;

export const buildTemplateListQuerySchema = z.object({ siteId: z.string().uuid(), kind: z.enum(['user', 'cap']).optional() }).strict();
export type BuildTemplateListQuery = z.infer<typeof buildTemplateListQuerySchema>;

export const callingPolicyMapListQuerySchema = z.object({ siteId: z.string().uuid() }).strict();
export type CallingPolicyMapListQuery = z.infer<typeof callingPolicyMapListQuerySchema>;

export const buildListQuerySchema = z.object({
  siteId: z.string().uuid(),
  q: z.string().trim().max(160).optional(),
  hidden: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type BuildListQuery = z.infer<typeof buildListQuerySchema>;

/* ------------------------------ Files DTOs ------------------------------ */

export const filesQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  category: z.enum(['deployment_change_document', 'number_port_document']).optional(),
  sourceType: z.string().max(60).optional(),
  sourceId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
});
export type FilesQuery = z.infer<typeof filesQuerySchema>;

/* ------------------------------ Shared search DTO ------------------------------ */

/** The plain `?q=` search param, for list endpoints with nothing else to filter by. */
export const searchQuerySchema = z.object({ q: z.string().trim().max(200).optional() }).strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;
