import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { deviceAlertSettingsSchema, deviceAutoSetupSchema, deviceInventoryInputSchema, deviceMonitorSettingsSchema, type DeviceAlertSettingsInput, type DeviceAutoSetupInput, type DeviceInventoryInput, type DeviceMonitorSettingsInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { RequireFeature } from '../../common/feature.guard';
import { TenantGuard } from '../../rbac/tenant.guard';
import { MonitoringEnabledGuard } from './monitoring-enabled.guard';
import { DeviceStatusService } from './device-status.service';

/**
 * Device status (docs/DEVICE-MONITORING.md): what Voxshift last read from the customer's Uptime Kuma status page, the list of devices to watch,
 * and the switch that lets Voxshift look after monitoring. Everyone who can see the customer sees the status screen (monitoring:read: project managers
 * and customers too); only engineers and administrators (monitoring:manage) see the watch list or change anything.
 */
@Controller('t/:tenantId/device-status')
@RequireFeature('monitoring')
@UseGuards(TenantGuard, MonitoringEnabledGuard)
export class DeviceStatusController {
  constructor(private readonly svc: DeviceStatusService) {}

  @Get()
  @RequirePermission('monitoring:read')
  overview(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.overview(t, u);
  }

  @Get('alerts')
  @RequirePermission('monitoring:manage')
  alerts(@TenantCtx() t: TenantContext) {
    return this.svc.alerts(t);
  }

  @Put('alerts')
  @RequirePermission('monitoring:manage')
  saveAlerts(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceAlertSettingsSchema)) body: DeviceAlertSettingsInput) {
    return this.svc.saveAlerts(t, u, body);
  }

  @Post('alerts/test')
  @HttpCode(200)
  @RequirePermission('monitoring:manage')
  testAlert(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.testAlert(t, u);
  }

  @Put('settings')
  @RequirePermission('monitoring:manage')
  saveSettings(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceMonitorSettingsSchema)) body: DeviceMonitorSettingsInput) {
    return this.svc.saveSettings(t, u, body);
  }

  @Post('auto-setup')
  @HttpCode(200)
  @RequirePermission('monitoring:manage')
  autoSetup(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceAutoSetupSchema)) body: DeviceAutoSetupInput) {
    return this.svc.autoSetup(t, u, body);
  }

  @Delete('auto-setup')
  @RequirePermission('monitoring:manage')
  stopManaging(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.stopManaging(t, u);
  }

  @Post('devices')
  @RequirePermission('monitoring:manage')
  addDevice(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Body(new ZodBody(deviceInventoryInputSchema)) body: DeviceInventoryInput) {
    return this.svc.addDevice(t, u, body);
  }

  @Put('devices/:id')
  @RequirePermission('monitoring:manage')
  updateDevice(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(deviceInventoryInputSchema)) body: DeviceInventoryInput) {
    return this.svc.updateDevice(t, u, id, body);
  }

  @Delete('devices/:id')
  @RequirePermission('monitoring:manage')
  removeDevice(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.removeDevice(t, u, id);
  }
}
