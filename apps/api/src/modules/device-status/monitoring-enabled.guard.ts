import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AppRequest } from '../../common/request';

/**
 * Per-customer switch for Monitoring (Administration > Customers). Runs after TenantGuard, which reads the customer's setting, and refuses the whole
 * monitoring controller for a customer it is switched off for. (The installation-wide switch is `@RequireFeature('monitoring')`.)
 */
@Injectable()
export class MonitoringEnabledGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const t = ctx.switchToHttp().getRequest<AppRequest>().tenant;
    if (t && t.monitoringEnabled === false) throw new ForbiddenException('Monitoring is not switched on for this customer.');
    return true;
  }
}
