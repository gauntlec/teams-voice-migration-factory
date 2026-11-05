import type { MeTenant, Permission, ReportKey } from '@tvmf/shared';

/**
 * Which reports the signed-in person can open for the active customer: the same rules as the data behind each one, so a
 * report is never offered that would then be refused.
 */
export function reportAvailable(key: ReportKey, can: (p: Permission) => boolean, tenant: MeTenant | undefined): boolean {
  if (!tenant) return false;
  switch (key) {
    case 'migration':
      return true;
    case 'changes':
      return can('deployment:read') || can('audit:read:tenant');
    case 'incidents':
      return tenant.managedServices && can('inc:read');
    case 'service-requests':
      return tenant.managedServices && can('sr:read');
    case 'devices':
      return tenant.monitoring && can('monitoring:read');
  }
}
