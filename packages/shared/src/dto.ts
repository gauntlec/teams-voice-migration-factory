import { z } from 'zod';
import { ROLES } from './rbac';

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
