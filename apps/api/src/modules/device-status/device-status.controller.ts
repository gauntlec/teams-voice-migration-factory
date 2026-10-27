import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { deviceAutoSetupSchema, deviceInventoryInputSchema, deviceMonitorSettingsSchema, type DeviceAutoSetupInput, type DeviceInventoryInput, type DeviceMonitorSettingsInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DeviceStatusService } from './device-status.service';

/**
 * Device status (docs/DEVICE-MONITORING.md): what Voxshift last read from the customer's Uptime Kuma status page, the list of devices to watch,
 * and the switch that lets Voxshift look after Kuma. Everyone who can read Discovery sees it; only staff who manage sites change anything.
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

  @Post('auto-setup')
  @HttpCode(200)
  @RequirePermission('discovery:sites:manage')
  autoSetup(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceAutoSetupSchema)) body: DeviceAutoSetupInput) {
    return this.svc.autoSetup(t, u, body);
  }

  @Delete('auto-setup')
  @RequirePermission('discovery:sites:manage')
  stopManaging(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.stopManaging(t, u);
  }

  @Post('devices')
  @RequirePermission('discovery:sites:manage')
  addDevice(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceInventoryInputSchema)) body: DeviceInventoryInput) {
    return this.svc.addDevice(t, u, body);
  }

  @Put('devices/:id')
  @RequirePermission('discovery:sites:manage')
  updateDevice(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(deviceInventoryInputSchema)) body: DeviceInventoryInput) {
    return this.svc.updateDevice(t, u, id, body);
  }

  @Delete('devices/:id')
  @RequirePermission('discovery:sites:manage')
  removeDevice(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.removeDevice(t, u, id);
  }
}
