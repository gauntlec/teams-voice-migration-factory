import { reportAvailableFor, type MeTenant, type Permission, type ReportKey } from '@tvmf/shared';

/**
 * Which reports the signed-in person can open for the active customer: the shared rule (reportAvailableFor), which the
 * api also checks before it makes a PDF, so a report is never offered and then refused.
 */
export function reportAvailable(key: ReportKey, can: (p: Permission) => boolean, tenant: MeTenant | undefined): boolean {
  return !!tenant && reportAvailableFor(key, can, tenant);
}
