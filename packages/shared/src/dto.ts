import { z } from 'zod';
import { ROLES } from './rbac';
import {
  FLOW_KINDS,
  LICENSING_MODELS,
  NETWORK_SCOPES,
  NETWORK_TYPES,
  NUMBER_RANGE_KINDS,
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

export const discoveryNumberRangeSchema = z
  .object({
    range_start: str(40).min(1),
    range_end: str(40).min(1),
    kind: z.enum(NUMBER_RANGE_KINDS),
    carrier: optStr(160),
    port_status: optStr(120),
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
