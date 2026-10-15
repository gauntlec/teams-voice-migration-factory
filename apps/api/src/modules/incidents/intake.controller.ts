import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { intakeSourceCreateSchema, intakeSourceUpdateSchema, type IntakeSourceCreateInput, type IntakeSourceUpdateInput } from '@tvmf/shared';
import { CurrentIntake, CurrentUser, Public, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, IntakePrincipal, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { IncidentDemoDataService } from './demo-data.service';
import { IncidentDemoService } from './incident-demo.service';
import { IncidentIntakeService } from './incident-intake.service';
import { IntakeAdminService } from './intake-admin.service';
import { IntakeAuthGuard } from './intake-auth.guard';

/**
 * Where monitoring tools post alerts (docs/INTAKE.md): /api/intake/v1. Authenticated by an intake token, not a person's login. The
 * body is a canonical alert ({dedupKey, title, severity, state ...}), or, for a Microsoft 365 service health source, a service
 * health issue.
 */
@Controller('intake/v1')
@Public()
@UseGuards(IntakeAuthGuard)
export class IntakeController {
  constructor(private readonly svc: IncidentIntakeService) {}

  /** Checks the token and says who it is: for setting a tool up. */
  @Get('ping')
  ping(@CurrentIntake() source: IntakePrincipal) {
    return { ok: true, source: source.name, kind: source.kind };
  }

  @Post('alerts')
  alert(@CurrentIntake() source: IntakePrincipal, @Body() body: unknown) {
    return this.svc.alert(source, body);
  }
}

/** Managing a customer's alert sources. Registered before IncidentsController so `intake-sources` isn't read as an incident id. */
@Controller('t/:tenantId/incidents')
@UseGuards(TenantGuard)
export class IntakeAdminController {
  constructor(
    private readonly svc: IntakeAdminService,
    private readonly demo: IncidentDemoService,
    private readonly demoData: IncidentDemoDataService,
  ) {}

  @Get('intake-sources')
  @RequirePermission('inc:manage')
  list(@TenantCtx() t: TenantContext) {
    return this.svc.list(t);
  }

  /** Demo incidents for a test customer. */
  @Post('demo')
  @RequirePermission('intake:manage')
  seedDemo(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.demo.seed(t, user);
  }

  /** Demo history (two months of incidents and requests, tagged, no emails): what is there, add it, take it away. */
  @Get('demo-data')
  @RequirePermission('intake:manage')
  demoDataStatus(@TenantCtx() t: TenantContext) {
    return this.demoData.status(t);
  }

  @Post('demo-data')
  @RequirePermission('intake:manage')
  seedDemoData(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.demoData.seed(t, user);
  }

  @Delete('demo-data')
  @RequirePermission('intake:manage')
  removeDemoData(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser) {
    return this.demoData.remove(t, user);
  }

  @Post('intake-sources')
  @RequirePermission('intake:manage')
  create(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(intakeSourceCreateSchema)) body: IntakeSourceCreateInput) {
    return this.svc.create(t, user, body);
  }

  @Patch('intake-sources/:id')
  @RequirePermission('intake:manage')
  update(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(intakeSourceUpdateSchema)) body: IntakeSourceUpdateInput) {
    return this.svc.update(t, user, id, body);
  }

  @Post('intake-sources/:id/rotate')
  @RequirePermission('intake:manage')
  rotate(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.rotate(t, user, id);
  }

  @Delete('intake-sources/:id')
  @RequirePermission('intake:manage')
  remove(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(t, user, id);
  }
}
