import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { HANDOVER_SECTIONS } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';

/**
 * Service Handover view — produces the handover pack from the final tenant
 * state, using the existing .docx as the section template. Scaffold: creates a
 * draft pack with the section skeleton; .docx rendering is a follow-up.
 */
@Controller('t/:tenantId/handover')
@UseGuards(TenantGuard)
export class HandoverController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get('packs')
  @RequirePermission('handover:read')
  list(@TenantCtx() t: TenantContext) {
    return tenantDb(this.db, t.schema)
      .selectFrom('handover_packs')
      .select(['id', 'version', 'status', 'generated_by', 'generated_at', 'created_at'])
      .orderBy('version', 'desc')
      .execute();
  }

  @Post('packs')
  @RequirePermission('handover:generate')
  async generate(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body() body: { notes?: string },
  ) {
    const scoped = tenantDb(this.db, t.schema);
    const last = await scoped
      .selectFrom('handover_packs')
      .select((eb) => eb.fn.max('version').as('v'))
      .executeTakeFirst();
    const version = Number(last?.v ?? 0) + 1;

    const pack = await scoped
      .insertInto('handover_packs')
      .values({
        version,
        status: 'draft',
        generated_by: user.id,
        source: { notes: body.notes ?? null, snapshotAt: new Date().toISOString() },
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await scoped
      .insertInto('handover_sections')
      .values(
        HANDOVER_SECTIONS.map((s, i) => ({
          pack_id: pack.id,
          key: s.key,
          title: s.title,
          ordinal: i,
          content: {},
        })),
      )
      .execute();

    await this.audit.tenant(t.schema, 'handover.pack_generated', {
      actor: { id: user.id, email: user.email },
      targetType: 'handover_pack',
      targetId: pack.id,
      detail: { version },
    });
    return { ...pack, sections: HANDOVER_SECTIONS.length };
  }

  @Get('packs/:id')
  @RequirePermission('handover:read')
  async get(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    const scoped = tenantDb(this.db, t.schema);
    const [pack, sections] = await Promise.all([
      scoped.selectFrom('handover_packs').selectAll().where('id', '=', id).executeTakeFirst(),
      scoped.selectFrom('handover_sections').selectAll().where('pack_id', '=', id).orderBy('ordinal').execute(),
    ]);
    return { pack, sections };
  }
}
