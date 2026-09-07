import { z } from 'zod';
import { ROLES } from './rbac';
import {
  CALLER_ID_OPTIONS,
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
  RESOURCE_ACCOUNT_KINDS,
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

export const createUserSchema = z.object({
  email: emailSchema,
  displayName: z.string().min(1).max(120),
  role: z.enum(ROLES),
  password: passwordSchema,
  tenantIds: z.array(z.string().uuid()).optional(),
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

export const discoverySiteSchema = z
  .object({
    site_code: optStr(60),
    name: optStr(200),
    address: optStr(500),
    country: optStr(80),
    region: optStr(120),
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
    scope: z.enum(NETWORK_SCOPES),
    subnet: str(64).min(1),
    mask: z.coerce.number().int().min(0).max(32).nullable().optional(),
    location: optStr(200),
    network_type: z.enum(NETWORK_TYPES).nullable().optional(),
  })
  .strict();
export type DiscoveryNetworkInput = z.infer<typeof discoveryNetworkSchema>;

export const discoveryFlowSchema = z
  .object({
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

const callerId = z.enum(CALLER_ID_OPTIONS).nullable().optional();
const uuidOrNull = z.string().uuid().nullable().optional();
/** '' from a cleared dropdown is treated as null. */
const refId = z.preprocess((v) => (v === '' ? null : v), uuidOrNull);

export const discoveryUserSchema = z
  .object({
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
    /** assign / move / clear this holder's number in the same call */
    phone_number_id: refId,
  })
  .strict();
export type DiscoveryUserInput = z.infer<typeof discoveryUserSchema>;

export const discoveryCapSchema = z
  .object({
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
