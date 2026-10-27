/**
 * Optional areas of the application that a Super Admin can switch off for one installation (Administration > Platform settings > Menus and
 * features): their menu entries disappear, their pages redirect away and their API answers "not found". Everything is on by default, so nothing
 * changes until someone switches an area off. To make another area switchable add it here, mark its API controllers with `@RequireFeature`
 * (apps/api/src/common/feature.guard.ts) and filter its menu entries and routes by `me.disabledFeatures` in the web app.
 */
import { z } from 'zod';

export const PLATFORM_FEATURES = ['feature_requests', 'bug_reports', 'msp', 'monitoring'] as const;
export type PlatformFeature = (typeof PLATFORM_FEATURES)[number];

export const PLATFORM_FEATURE_INFO: Record<PlatformFeature, { label: string; description: string; menus: string[] }> = {
  feature_requests: { label: 'Feature requests', description: 'A board where people suggest and vote on improvements to Voxshift.', menus: ['Feature requests'] },
  bug_reports: { label: 'Bug reports', description: 'A board where people report problems with Voxshift.', menus: ['Bug reports'] },
  msp: {
    label: 'MSP features',
    description: 'The managed service provider console: the MSP incident console, the service request queue and MSP administration. Switch off on a customer\'s own installation.',
    menus: ['Incident console', 'Service request admin', 'MSPs'],
  },
  monitoring: {
    label: 'Monitoring',
    description: 'Live status of the devices each customer wants watched (Devices, Watch list, Alerts), and the background reading, set-up and alert emails behind it. Each customer can also be switched off on its own on the Customers page.',
    menus: ['Devices', 'Watch list', 'Alerts'],
  },
};

export const setFeaturesSchema = z.object({ disabled: z.array(z.enum(PLATFORM_FEATURES)).max(PLATFORM_FEATURES.length) }).strict();
export type SetFeaturesInput = z.infer<typeof setFeaturesSchema>;

/** Is this area on, given the list switched off? */
export const featureOn = (disabled: readonly string[] | undefined, feature: PlatformFeature): boolean => !(disabled ?? []).includes(feature);

/**
 * The permissions that only make sense while an area is on. The web app treats them as not granted while the area is off, so every menu entry, page
 * and field that is gated by one of them disappears together without each page needing to know. (The API enforces it separately with `@RequireFeature`.)
 */
export const FEATURE_PERMISSIONS: Record<PlatformFeature, readonly string[]> = {
  feature_requests: ['feature:read', 'feature:create', 'feature:manage'],
  bug_reports: ['bug:read', 'bug:create', 'bug:manage'],
  msp: ['msp:create', 'msp:read', 'msp:update', 'msp:delete', 'inc:msp', 'sr:msp'],
  monitoring: ['monitoring:read', 'monitoring:manage'],
};

/** Is this permission switched off because an area it belongs to is off? */
export const permissionBlocked = (disabled: readonly string[] | undefined, permission: string): boolean =>
  PLATFORM_FEATURES.some((f) => (disabled ?? []).includes(f) && FEATURE_PERMISSIONS[f].includes(permission));
