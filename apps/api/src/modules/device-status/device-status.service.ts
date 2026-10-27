import { Injectable } from '@nestjs/common';
import { deviceStatusOverview, saveDeviceMonitorSettings, tenantDb } from '@tvmf/db';
import type { DeviceMonitorSettingsInput } from '@tvmf/shared';
import { InjectDb, type Db } from '../../db/db.module';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';

@Injectable()
export class DeviceStatusService {
  constructor(@InjectDb() private readonly db: Db, private readonly audit: AuditService) {}

  overview(t: TenantContext) {
    return deviceStatusOverview(tenantDb(this.db, t.schema));
  }

  async saveSettings(t: TenantContext, u: AuthedUser, input: DeviceMonitorSettingsInput) {
    const saved = await saveDeviceMonitorSettings(tenantDb(this.db, t.schema), input);
    await this.audit.tenant(t.schema, 'discovery.device_status_settings_updated', {
      actor: { id: u.id, email: u.email },
      targetType: 'device_monitor_settings',
      targetId: 'kuma',
      detail: { enabled: saved.enabled, kumaUrl: saved.kumaUrl, statusSlug: saved.statusSlug },
    });
    return this.overview(t);
  }
}
