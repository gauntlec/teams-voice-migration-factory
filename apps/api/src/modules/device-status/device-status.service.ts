import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDevice, canonicalSiteCode, deviceStatusOverview, disableManagedKuma, enableManagedKuma, removeDevice, saveDeviceMonitorSettings, tenantDb, updateDevice } from '@tvmf/db';
import type { DeviceAutoSetupInput, DeviceInventoryInput, DeviceMonitorSettingsInput } from '@tvmf/shared';
import { InjectDb, type Db } from '../../db/db.module';
import { AuditService } from '../../common/audit.service';
import { encryptSecret } from '../../common/crypto';
import type { AuthedUser, TenantContext } from '../../common/request';

@Injectable()
export class DeviceStatusService {
  constructor(@InjectDb() private readonly db: Db, private readonly audit: AuditService) {}

  private s(t: TenantContext) { return tenantDb(this.db, t.schema); }
  private actor(u: AuthedUser) { return { id: u.id, email: u.email }; }

  overview(t: TenantContext) {
    return deviceStatusOverview(this.s(t));
  }

  async saveSettings(t: TenantContext, u: AuthedUser, input: DeviceMonitorSettingsInput) {
    const saved = await saveDeviceMonitorSettings(this.s(t), input);
    await this.audit.tenant(t.schema, 'discovery.device_status_settings_updated', {
      actor: this.actor(u),
      targetType: 'device_monitor_settings',
      targetId: 'kuma',
      detail: { enabled: saved.enabled, kumaUrl: saved.kumaUrl, statusSlug: saved.statusSlug },
    });
    return this.overview(t);
  }

  /** Voxshift looks after Kuma: switches device status on, and the worker makes Kuma match the device list. The administrator's password is stored encrypted and never shown again. */
  async autoSetup(t: TenantContext, u: AuthedUser, input: DeviceAutoSetupInput) {
    if (!!input.adminUser !== !!input.adminPassword) throw new BadRequestException('Give both the Kuma administrator name and password, or neither.');
    await enableManagedKuma(this.s(t), {
      kumaUrl: input.kumaUrl || undefined,
      adminUser: input.adminUser || undefined,
      adminPassEnc: input.adminPassword ? encryptSecret(input.adminPassword) : undefined,
    });
    await this.audit.tenant(t.schema, 'discovery.device_status_managed', {
      actor: this.actor(u),
      targetType: 'device_monitor_settings',
      targetId: 'kuma',
      detail: { managed: true, kumaUrl: input.kumaUrl || null, adminSupplied: !!input.adminUser },
    });
    return this.overview(t);
  }

  async stopManaging(t: TenantContext, u: AuthedUser) {
    await disableManagedKuma(this.s(t));
    await this.audit.tenant(t.schema, 'discovery.device_status_managed', { actor: this.actor(u), targetType: 'device_monitor_settings', targetId: 'kuma', detail: { managed: false } });
    return this.overview(t);
  }

  /** The device is stored as typed except the site code, which is written the way the site has it. */
  private async checked(t: TenantContext, input: DeviceInventoryInput): Promise<DeviceInventoryInput> {
    const code = await canonicalSiteCode(this.s(t), input.siteCode);
    if (!code) throw new BadRequestException(`There is no site "${input.siteCode}". Choose one of this customer's sites.`);
    return { ...input, siteCode: code };
  }

  async addDevice(t: TenantContext, u: AuthedUser, input: DeviceInventoryInput) {
    const row = await addDevice(this.s(t), await this.checked(t, input));
    await this.audit.tenant(t.schema, 'discovery.device_added', { actor: this.actor(u), targetType: 'device_inventory', targetId: row.id, detail: { name: row.name, site: row.siteCode, kind: row.kind, checkType: row.checkType } });
    return row;
  }

  async updateDevice(t: TenantContext, u: AuthedUser, id: string, input: DeviceInventoryInput) {
    const row = await updateDevice(this.s(t), id, await this.checked(t, input));
    if (!row) throw new NotFoundException('That device is not on the list.');
    await this.audit.tenant(t.schema, 'discovery.device_updated', { actor: this.actor(u), targetType: 'device_inventory', targetId: id, detail: { name: row.name, site: row.siteCode } });
    return row;
  }

  async removeDevice(t: TenantContext, u: AuthedUser, id: string) {
    if (!(await removeDevice(this.s(t), id))) throw new NotFoundException('That device is not on the list.');
    await this.audit.tenant(t.schema, 'discovery.device_removed', { actor: this.actor(u), targetType: 'device_inventory', targetId: id, detail: {} });
    return { ok: true };
  }
}
