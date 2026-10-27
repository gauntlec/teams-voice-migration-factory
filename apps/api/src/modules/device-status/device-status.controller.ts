import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { deviceMonitorSettingsSchema, type DeviceMonitorSettingsInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DeviceStatusService } from './device-status.service';

/**
 * Device status (docs/DEVICE-MONITORING.md): what Voxshift last read from the customer's Uptime Kuma status page. Everyone who can read
 * Discovery sees it; only staff who manage sites change where Kuma is.
 */
@Controller('t/:tenantId/device-status')
@UseGuards(TenantGuard)
export class DeviceStatusController {
  constructor(private readonly svc: DeviceStatusService) {}

  @Get()
  @RequirePermission('discovery:read')
  overview(@TenantCtx() t: TenantContext) {
    return this.svc.overview(t);
  }

  @Put('settings')
  @RequirePermission('discovery:sites:manage')
  saveSettings(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceMonitorSettingsSchema)) body: DeviceMonitorSettingsInput) {
    return this.svc.saveSettings(t, u, body);
  }
}
