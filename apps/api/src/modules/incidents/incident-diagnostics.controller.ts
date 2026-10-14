import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { DIAG_RUNBOOKS, diagInputSchema, type DiagRunInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { IncidentDiagnosticsService } from './incident-diagnostics.service';

/**
 * The engineer's side of the diagnostic checks (docs/DIAGNOSTICS.md): what has been run on an incident, which
 * checks are worth running, and run one. Staff only (inc:manage): results are internal. Read-only checks, so
 * they never change the incident.
 */
@Controller('t/:tenantId/incidents/:id/diagnostics')
@UseGuards(TenantGuard)
export class IncidentDiagnosticsController {
  constructor(private readonly svc: IncidentDiagnosticsService) {}

  @Get()
  @RequirePermission('inc:manage')
  async list(@TenantCtx() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    const [results, suggestions] = await Promise.all([this.svc.list(t, id), this.svc.suggest(t, id)]);
    return { runbooks: Object.values(DIAG_RUNBOOKS), results, suggestions };
  }

  @Post()
  @RequirePermission('inc:manage')
  run(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(diagInputSchema)) body: DiagRunInput) {
    return this.svc.run(t, user, id, body);
  }
}
