import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import {
  setBaseUrlSchema,
  setEmailEnabledSchema,
  setMaintenanceNoticeSchema,
  type BaseUrlView,
  type MaintenanceNoticeView,
  type ReleaseCheck,
  type SetBaseUrlInput,
  type SetEmailEnabledInput,
  type SetMaintenanceNoticeInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import { AuditService } from '../common/audit.service';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { InjectDb, type Db } from '../db/db.module';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { BaseUrlService } from './base-url.service';
import { currentMaintenance } from './maintenance';
import { collectReleaseCheck } from './release-check';

/**
 * Release safety (docs/ARCHITECTURE.md "Operations"): what a release would
 * interrupt, and the maintenance notice staff see before one.
 */
@Controller('platform')
export class PlatformOpsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly baseUrl: BaseUrlService,
  ) {}

  /** SUPER_ADMIN: every live sign-in, discovery run and deployment a worker restart would end. */
  @Get('release-check')
  @RequirePermission('platform:operate')
  releaseCheck(): Promise<ReleaseCheck> {
    return collectReleaseCheck(this.db);
  }

  /** The banner: any signed-in staff member. Customers have no live sessions to lose, so they get null. */
  @Get('maintenance')
  async maintenance(@CurrentUser() user: AuthedUser): Promise<MaintenanceNoticeView | null> {
    if (user.role === 'CUSTOMER') return null;
    return currentMaintenance(this.db);
  }

  @Put('maintenance')
  @RequirePermission('platform:operate')
  async setMaintenance(
    @Body(new ZodBody(setMaintenanceNoticeSchema)) body: SetMaintenanceNoticeInput,
    @CurrentUser() user: AuthedUser,
  ): Promise<MaintenanceNoticeView | null> {
    const startsAt = new Date(body.startsAt).toISOString();
    await platformDb(this.db)
      .insertInto('maintenance_notice')
      .values({ id: true, message: body.message, starts_at: startsAt, created_by: user.id })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ message: body.message, starts_at: startsAt, created_by: user.id, created_at: new Date().toISOString() }),
      )
      .execute();
    await this.audit.platform('platform.maintenance_notice_set', {
      actor: { id: user.id, email: user.email },
      targetType: 'maintenance_notice',
      detail: { message: body.message, startsAt },
    });
    return currentMaintenance(this.db);
  }

  @Delete('maintenance')
  @RequirePermission('platform:operate')
  async clearMaintenance(@CurrentUser() user: AuthedUser): Promise<{ cleared: boolean }> {
    const r = await platformDb(this.db).deleteFrom('maintenance_notice').executeTakeFirst();
    await this.audit.platform('platform.maintenance_notice_cleared', {
      actor: { id: user.id, email: user.email },
      targetType: 'maintenance_notice',
    });
    return { cleared: Number(r.numDeletedRows) > 0 };
  }

  /** The platform settings: the address this installation is reached at (and the connection details built from it) and the email switch. Any signed-in staff member. */
  @Get('settings')
  async getSettings(@CurrentUser() user: AuthedUser): Promise<BaseUrlView | null> {
    if (user.role === 'CUSTOMER') return null;
    return this.baseUrl.view();
  }

  /** SUPER_ADMIN: set the address (`baseUrl: null` goes back to the WEB_ORIGIN environment value). */
  @Put('base-url')
  @RequirePermission('platform:operate')
  async setBaseUrl(@Body(new ZodBody(setBaseUrlSchema)) body: SetBaseUrlInput, @CurrentUser() user: AuthedUser): Promise<BaseUrlView> {
    const before = (await this.baseUrl.view()).baseUrl;
    const view = await this.baseUrl.set(body.baseUrl, user.id);
    await this.audit.platform('platform.base_url_set', {
      actor: { id: user.id, email: user.email },
      targetType: 'app_settings',
      detail: { from: before, to: view.baseUrl, source: view.source },
    });
    return view;
  }

  /** SUPER_ADMIN: the master email switch. `enabled: false` stops all email being generated or sent. */
  @Put('email-delivery')
  @RequirePermission('platform:operate')
  async setEmailDelivery(@Body(new ZodBody(setEmailEnabledSchema)) body: SetEmailEnabledInput, @CurrentUser() user: AuthedUser): Promise<BaseUrlView> {
    const view = await this.baseUrl.setEmailEnabled(body.enabled, user.id);
    await this.audit.platform(body.enabled ? 'platform.email_switched_on' : 'platform.email_switched_off', {
      actor: { id: user.id, email: user.email },
      targetType: 'app_settings',
    });
    return view;
  }
}
