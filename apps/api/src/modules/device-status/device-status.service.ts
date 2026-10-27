import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDevice, canonicalSiteCode, deviceAlertView, deviceStatusOverview, disableManagedKuma, enableManagedKuma, removeDevice, saveDeviceAlertSettings, saveDeviceMonitorSettings, tenantDb, updateDevice, webOrigin } from '@tvmf/db';
import { buildDeviceAlertContext, can, DEVICE_ALERT_FREQUENCY_LABEL, isTenantStatusSlug, kumaSlugForTenant, type DeviceAlertPlan, type DeviceAlertSettingsInput, type DeviceAutoSetupInput, type DeviceInventoryInput, type DeviceMonitorSettingsInput, type DeviceStatusOverview } from '@tvmf/shared';
import { MailService } from '../../mail/mail.service';
import { InjectDb, type Db } from '../../db/db.module';
import { AuditService } from '../../common/audit.service';
import { encryptSecret } from '../../common/crypto';
import type { AuthedUser, TenantContext } from '../../common/request';

@Injectable()
export class DeviceStatusService {
  constructor(@InjectDb() private readonly db: Db, private readonly audit: AuditService, private readonly mail: MailService) {}

  private s(t: TenantContext) { return tenantDb(this.db, t.schema); }
  private actor(u: AuthedUser) { return { id: u.id, email: u.email }; }

  /**
   * What the Devices (status) screen needs, and for people who may manage monitoring, also the watch list and the setup. Anyone else sees the
   * status only: no watch list, no addresses, no setup state. A customer limited to some sites sees only those sites' devices.
   */
  async overview(t: TenantContext, u: AuthedUser): Promise<DeviceStatusOverview> {
    const o = await deviceStatusOverview(this.s(t));
    let view: DeviceStatusOverview = o;
    if (!can(u.role, 'monitoring:manage')) {
      view = {
        ...o,
        settings: { enabled: o.settings.enabled, kumaUrl: '', statusSlug: '', lastPolledAt: null, lastOkAt: o.settings.lastOkAt, lastError: o.settings.lastError ? 'The latest device status could not be read.' : null },
        managed: { managed: false, hasCredentials: false, syncNeeded: false, lastSyncAt: null, lastSyncError: null },
        inventory: [],
        siteOptions: [],
      };
    }
    if (t.siteScope && t.siteScope.length) {
      const sites = await this.s(t).selectFrom('discovery_sites').select('sitecode').where('id', 'in', t.siteScope).execute();
      const allowed = new Set(sites.map((x) => x.sitecode.toLowerCase()));
      const keep = (code: string | null) => code !== null && allowed.has(code.toLowerCase());
      view = { ...view, devices: view.devices.filter((d) => keep(d.sitecode)), sites: view.sites.filter((x) => keep(x.sitecode)), changes: view.changes.filter((c) => keep(c.sitecode)), inventory: [], siteOptions: [] };
    }
    return view;
  }

  /** Alert settings and who they would reach. */
  alerts(t: TenantContext) {
    return deviceAlertView(this.s(t), this.db, t.id);
  }

  async saveAlerts(t: TenantContext, u: AuthedUser, input: DeviceAlertSettingsInput) {
    await saveDeviceAlertSettings(this.s(t), input);
    await this.audit.tenant(t.schema, 'monitoring.alerts_updated', {
      actor: this.actor(u),
      targetType: 'device_alert_settings',
      targetId: 'alerts',
      detail: { enabled: input.enabled, frequency: input.frequency, reminderHours: input.reminderHours, notifyEngineers: input.notifyEngineers, notifyProjectManagers: input.notifyProjectManagers, extraRecipients: input.recipients.length },
    });
    return this.alerts(t);
  }

  /** Sends a sample alert to the person who asked, so they can see what arrives (and that mail works) before relying on it. */
  async testAlert(t: TenantContext, u: AuthedUser) {
    const cur = await this.alerts(t);
    if (cur.emailOff) throw new BadRequestException('Email is switched off for this installation (Administration > Platform settings), so no alert can be sent.');
    const now = new Date();
    const sample: DeviceAlertPlan = {
      send: true,
      wentDown: [{ kumaId: 0, name: 'Reception door paging', sitecode: 'SITE01', deviceKind: 'algo', at: now.toISOString() }],
      recovered: [{ kumaId: 0, name: 'Boardroom Teams Room', sitecode: 'SITE02', deviceKind: 'teams-room', at: now.toISOString() }],
      stillDown: [],
      remindedIds: [],
      cursor: '0',
    };
    const origin = await webOrigin(this.db);
    const context = buildDeviceAlertContext(sample, { customerName: t.name, frequencyLabel: DEVICE_ALERT_FREQUENCY_LABEL[cur.frequency], monitoringUrl: `${origin}/monitoring/devices`, alertsUrl: `${origin}/monitoring/alerts`, test: true });
    await this.mail.enqueue({ template: 'device_alert', to: { email: u.email, name: u.displayName }, context: context as unknown as Record<string, unknown>, related: { type: 'device_alert_test', id: t.id }, tenantId: t.id, createdBy: u.id });
    return { sentTo: u.email };
  }

  async saveSettings(t: TenantContext, u: AuthedUser, input: DeviceMonitorSettingsInput) {
    // Each customer's managed status page is its own. Nobody may point their customer at the page Voxshift made for a different one.
    if (isTenantStatusSlug(input.statusSlug) && input.statusSlug !== kumaSlugForTenant(t.id)) {
      throw new BadRequestException('That status page belongs to another customer. Use this customer\'s own, or a different one.');
    }
    const saved = await saveDeviceMonitorSettings(this.s(t), input);
    await this.audit.tenant(t.schema, 'discovery.device_status_settings_updated', {
      actor: this.actor(u),
      targetType: 'device_monitor_settings',
      targetId: 'kuma',
      detail: { enabled: saved.enabled, address: saved.kumaUrl, statusPage: saved.statusSlug },
    });
    return this.overview(t, u);
  }

  /** Voxshift looks after Kuma: switches device status on, and the worker makes Kuma match the device list. The administrator's password is stored encrypted and never shown again. */
  async autoSetup(t: TenantContext, u: AuthedUser, input: DeviceAutoSetupInput) {
    if (!!input.adminUser !== !!input.adminPassword) throw new BadRequestException('Give both the administrator name and password, or neither.');
    await enableManagedKuma(this.s(t), {
      tenantId: t.id,
      kumaUrl: input.kumaUrl || undefined,
      adminUser: input.adminUser || undefined,
      adminPassEnc: input.adminPassword ? encryptSecret(input.adminPassword) : undefined,
    });
    await this.audit.tenant(t.schema, 'discovery.device_status_managed', {
      actor: this.actor(u),
      targetType: 'device_monitor_settings',
      targetId: 'kuma',
      detail: { managed: true, address: input.kumaUrl || null, adminSupplied: !!input.adminUser },
    });
    return this.overview(t, u);
  }

  async stopManaging(t: TenantContext, u: AuthedUser) {
    await disableManagedKuma(this.s(t));
    await this.audit.tenant(t.schema, 'discovery.device_status_managed', { actor: this.actor(u), targetType: 'device_monitor_settings', targetId: 'kuma', detail: { managed: false } });
    return this.overview(t, u);
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
