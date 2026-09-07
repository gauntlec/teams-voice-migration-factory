import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '../../common/request';

/**
 * Site-scope enforcement for Data Collection. `t.siteScope` is set by
 * `TenantGuard`: `null` for whole-customer access, or the list of
 * `discovery_sites.id` values a "site contact" is limited to.
 */

/** Throw unless the caller may touch a row belonging to `siteId`. */
export function assertSiteInScope(t: TenantContext, siteId: string | null | undefined): void {
  if (!t.siteScope) return;
  if (!siteId || !t.siteScope.includes(siteId)) {
    throw new ForbiddenException('That record belongs to a site outside your access.');
  }
}

/** Throw when the caller is site-scoped at all (for customer-wide actions). */
export function assertCustomerWide(t: TenantContext, what: string): void {
  if (t.siteScope) {
    throw new ForbiddenException(`${what} is managed at the customer level, not per site.`);
  }
}

/** true when reads/writes must be narrowed to `t.siteScope`. */
export function isSiteScoped(t: TenantContext): t is TenantContext & { siteScope: string[] } {
  return Array.isArray(t.siteScope) && t.siteScope.length > 0;
}
