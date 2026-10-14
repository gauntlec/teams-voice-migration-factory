import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { handBackSchema, srProposalDecisionSchema, type HandBackInput, type SrProposalDecisionInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { SrAgentsService } from './sr-agents.service';
import { SrProposalsService } from './sr-proposals.service';

/**
 * The person's side of working a service request with an AI assistant: decide its proposals (a deploy names the tenant
 * session it will run on), take over from it, hand it back, and list the assistants a request can be given to. Engineers and
 * admins (sr:manage). Registered before ServiceRequestsController so `agents` isn't read as a request id.
 */
@Controller('t/:tenantId/service-requests')
@UseGuards(TenantGuard)
export class SrAgentsController {
  constructor(
    private readonly agents: SrAgentsService,
    private readonly proposals: SrProposalsService,
  ) {}

  @Get('agents')
  @RequirePermission('sr:manage')
  list(@TenantCtx() t: TenantContext) {
    return this.agents.agents(t);
  }

  @Post(':id/proposals/:proposalId/decision')
  @RequirePermission('sr:manage')
  decide(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Param('proposalId', ParseUUIDPipe) proposalId: string, @Body(new ZodBody(srProposalDecisionSchema)) body: SrProposalDecisionInput) {
    return this.proposals.decide(t, user, id, proposalId, body);
  }

  @Post(':id/takeover')
  @RequirePermission('sr:manage')
  takeOver(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.agents.takeOver(t, user, id);
  }

  @Post(':id/hand-back')
  @RequirePermission('sr:manage')
  handBack(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(handBackSchema)) body: HandBackInput) {
    return this.agents.handBack(t, user, id, body.agentId);
  }
}
