import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';

/**
 * Design & Build view — replaces the ATTC build workbook. Scaffold covers the
 * USERS grid; CAPS / AAs / CQs / M365 groups follow the same shape.
 */
@Controller('t/:tenantId/build')
@UseGuards(TenantGuard)
export class BuildController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get('summary')
  @RequirePermission('build:read')
  async summary(@TenantCtx() t: TenantContext) {
    const s = tenantDb(this.db, t.schema);
    const count = async (table: 'build_users' | 'build_caps' | 'build_auto_attendants' | 'build_call_queues' | 'build_m365_groups') =>
      Number((await s.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    return {
      users: await count('build_users'),
      caps: await count('build_caps'),
      autoAttendants: await count('build_auto_attendants'),
      callQueues: await count('build_call_queues'),
      m365Groups: await count('build_m365_groups'),
    };
  }

  @Get('users')
  @RequirePermission('build:read')
  listUsers(@TenantCtx() t: TenantContext, @Query('limit') limit = '200') {
    return tenantDb(this.db, t.schema)
      .selectFrom('build_users')
      .selectAll()
      .orderBy('upn')
      .limit(Math.min(Number(limit) || 200, 1000))
      .execute();
  }

  @Post('users')
  @RequirePermission('build:write')
  async createUser(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body() body: { upn: string; did?: string; number_type?: string; migration_wave?: string },
  ) {
    const row = await tenantDb(this.db, t.schema)
      .insertInto('build_users')
      .values({
        upn: body.upn,
        did: body.did ?? null,
        number_type: body.number_type ?? null,
        migration_wave: body.migration_wave ?? null,
        policies: {},
        voicemail: {},
        call_forwarding: {},
        delegates: [],
        pickup_group: {},
        validation: {},
        status: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'build.user_created', {
      actor: { id: user.id, email: user.email },
      targetType: 'build_user',
      targetId: row.id,
    });
    return row;
  }

  @Patch('users/:id')
  @RequirePermission('build:write')
  async updateUser(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const allowed: Record<string, unknown> = {};
    for (const k of [
      'did', 'ext', 'e164', 'number_type', 'revoke_ev', 'hold_uri', 'action',
      'migration_wave', 'policies', 'voicemail', 'call_forwarding', 'delegates',
      'pickup_group', 'comments', 'hidden',
    ]) {
      if (k in body) allowed[k] = body[k];
    }
    allowed.updated_at = new Date().toISOString();
    const row = await tenantDb(this.db, t.schema)
      .updateTable('build_users')
      .set(allowed)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    await this.audit.tenant(t.schema, 'build.user_updated', {
      actor: { id: user.id, email: user.email },
      targetType: 'build_user',
      targetId: id,
      detail: { fields: Object.keys(allowed) },
    });
    return row;
  }
}
