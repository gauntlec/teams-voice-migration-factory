import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  can,
  knowledgeCreateSchema,
  knowledgeFeedbackSchema,
  knowledgeMatchQuerySchema,
  knowledgeUpdateSchema,
  type KnowledgeCreateInput,
  type KnowledgeUpdateInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { IncidentKnowledgeService } from './incident-knowledge.service';

/** Knowledge saved from resolved incidents (docs/INTAKE.md). Registered before IncidentsController so `knowledge` isn't read as an incident id. */
@Controller('t/:tenantId/incidents/knowledge')
@UseGuards(TenantGuard)
export class IncidentKnowledgeController {
  constructor(private readonly svc: IncidentKnowledgeService) {}

  @Get()
  @RequirePermission('inc:manage')
  list(@TenantCtx() t: TenantContext) {
    return this.svc.list(t);
  }

  /** What matches a category (and the words typed so far). Customers get only the tips written for them. */
  @Get('match')
  @RequirePermission('inc:read')
  match(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Query(new ZodBody(knowledgeMatchQuerySchema)) q: { category: string; subcategory?: string; q?: string }) {
    return this.svc.match(t, { category: q.category, subcategory: q.subcategory, text: q.q }, can(user.role, 'inc:manage'));
  }

  @Get('draft/:incidentId')
  @RequirePermission('inc:manage')
  draft(@TenantCtx() t: TenantContext, @Param('incidentId', ParseUUIDPipe) incidentId: string) {
    return this.svc.draftFrom(t, incidentId);
  }

  @Get('for/:incidentId')
  @RequirePermission('inc:manage')
  forIncident(@TenantCtx() t: TenantContext, @Param('incidentId', ParseUUIDPipe) incidentId: string) {
    return this.svc.matchIncident(t, incidentId);
  }

  @Post()
  @RequirePermission('inc:manage')
  create(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Body(new ZodBody(knowledgeCreateSchema)) body: KnowledgeCreateInput) {
    return this.svc.create(t, user, body);
  }

  @Patch(':id')
  @RequirePermission('inc:manage')
  update(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(knowledgeUpdateSchema)) body: KnowledgeUpdateInput) {
    return this.svc.update(t, user, id, body);
  }

  @Post(':id/feedback')
  @RequirePermission('inc:read')
  feedback(@TenantCtx() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(knowledgeFeedbackSchema)) body: { helpful: boolean }) {
    return this.svc.feedback(t, id, body.helpful);
  }

  @Delete(':id')
  @RequirePermission('inc:manage')
  archive(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.archive(t, user, id);
  }
}
