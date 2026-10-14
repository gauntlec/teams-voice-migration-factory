import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  can,
  createProblemSchema,
  declareMajorSchema,
  incidentReportQuerySchema,
  incidentReviewSchema,
  knownErrorsQuerySchema,
  linkChildrenSchema,
  linkProblemSchema,
  majorRolesSchema,
  majorUpdateSchema,
  updateProblemSchema,
  type CreateProblemInput,
  type DeclareMajorInput,
  type IncidentReportQuery,
  type IncidentReviewInput,
  type KnownErrorsQuery,
  type LinkChildrenInput,
  type LinkProblemInput,
  type MajorRolesInput,
  type MajorUpdateInput,
  type UpdateProblemInput,
} from '@tvmf/shared';
import { platformDb } from '@tvmf/db';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { InjectDb, type Db } from '../../db/db.module';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { IncidentMajorService } from './incident-major.service';
import { IncidentReportService } from './incident-report.service';
import { IncidentReviewService } from './incident-review.service';
import { ProblemsService } from './problems.service';

/**
 * Major incidents, child incidents, problem records, post-incident reviews, customer notices
 * and the report - everything on /incidents that is not the incident itself. Registered before
 * IncidentsController so its fixed paths (`problems`, `report`, `notices` ...) win over `:id`.
 */
@Controller('t/:tenantId/incidents')
@UseGuards(TenantGuard)
export class IncidentMajorController {
  constructor(
    private readonly major: IncidentMajorService,
    private readonly problems: ProblemsService,
    private readonly reviews: IncidentReviewService,
    private readonly reports: IncidentReportService,
    @InjectDb() private readonly db: Db,
  ) {}

  /** Live major incidents as the customer is told about them. */
  @Get('notices')
  @RequirePermission('inc:read')
  notices(@TenantCtx() t: TenantContext) {
    return this.major.notices(t);
  }

  @Get('report')
  @RequirePermission('inc:read')
  report(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(incidentReportQuerySchema)) q: IncidentReportQuery) {
    return this.reports.report(t, q.from, q.to, can(user.role, 'inc:manage'));
  }

  /** Active customer users on this customer - who can be a named stakeholder. */
  @Get('customer-users')
  @RequirePermission('inc:manage')
  async customerUsers(@TenantCtx() t: TenantContext) {
    return platformDb(this.db)
      .selectFrom('users as u')
      .innerJoin('tenant_memberships as m', 'm.user_id', 'u.id')
      .select(['u.id as id', 'u.display_name as display_name', 'u.email as email'])
      .where('m.tenant_id', '=', t.id)
      .where('u.role', '=', 'CUSTOMER')
      .where('u.status', '=', 'active')
      .orderBy('u.display_name')
      .execute();
  }

  /** What a customer or engineer can be told before raising an incident of this kind. */
  @Get('known-errors')
  @RequirePermission('inc:read')
  knownErrors(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(knownErrorsQuerySchema)) q: KnownErrorsQuery) {
    return this.problems.knownErrors(t, q, can(user.role, 'inc:manage'));
  }

  /* Problems: engineers and admins. */

  @Get('problems')
  @RequirePermission('inc:manage')
  listProblems(@TenantCtx() t: TenantContext, @Query('status') status?: string) {
    return this.problems.list(t, status);
  }

  @Post('problems')
  @RequirePermission('inc:manage')
  createProblem(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(createProblemSchema)) body: CreateProblemInput) {
    return this.problems.create(t, user, body);
  }

  @Get('problems/:problemId')
  @RequirePermission('inc:manage')
  getProblem(@TenantCtx() t: TenantContext, @Param('problemId') problemId: string) {
    return this.problems.get(t, problemId);
  }

  @Patch('problems/:problemId')
  @RequirePermission('inc:manage')
  updateProblem(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('problemId') problemId: string, @Body(new ZodBody(updateProblemSchema)) body: UpdateProblemInput) {
    return this.problems.update(t, user, problemId, body);
  }

  /* One incident's major / problem / review parts. */

  @Post(':id/major')
  @RequirePermission('inc:manage')
  declare(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(declareMajorSchema)) body: DeclareMajorInput) {
    return this.major.declare(t, user, id, body);
  }

  @Post(':id/major/updates')
  @RequirePermission('inc:manage')
  postUpdate(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(majorUpdateSchema)) body: MajorUpdateInput) {
    return this.major.postUpdate(t, user, id, body);
  }

  @Patch(':id/major')
  @RequirePermission('inc:manage')
  setRoles(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(majorRolesSchema)) body: MajorRolesInput) {
    if (!body.leadId && !body.commsId) throw new BadRequestException('Choose a new lead or comms owner.');
    return this.major.setRoles(t, user, id, body);
  }

  @Post(':id/children')
  @RequirePermission('inc:manage')
  linkChildren(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(linkChildrenSchema)) body: LinkChildrenInput) {
    return this.major.linkChildren(t, user, id, body);
  }

  @Delete(':id/children/:childId')
  @RequirePermission('inc:manage')
  unlinkChild(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Param('childId') childId: string) {
    return this.major.unlinkChild(t, user, id, childId);
  }

  @Post(':id/problem')
  @RequirePermission('inc:manage')
  linkProblem(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(linkProblemSchema)) body: LinkProblemInput) {
    return this.problems.link(t, user, id, body);
  }

  @Get(':id/review')
  @RequirePermission('inc:read')
  getReview(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.reviews.get(t, id, can(user.role, 'inc:manage'));
  }

  @Put(':id/review')
  @RequirePermission('inc:manage')
  putReview(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(incidentReviewSchema)) body: IncidentReviewInput) {
    return this.reviews.put(t, user, id, body);
  }

  @Post(':id/review/share')
  @RequirePermission('inc:manage')
  shareReview(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.reviews.share(t, user, id);
  }
}
