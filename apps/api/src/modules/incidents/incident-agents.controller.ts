import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { askAssistantSchema, handBackSchema, proposalDecisionSchema, type AskAssistantInput, type HandBackInput, type ProposalDecisionInput } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { IncidentProposalsService } from './agent-proposals.service';
import { BuiltinAgentsService } from './builtin-agents.service';
import { IncidentAgentsService } from './incident-agents.service';

/**
 * The person's side of working an incident with an AI assistant: decide its proposals, take over from it,
 * hand it back, and list the assistants an incident can be given to. Engineers and admins (inc:manage).
 * Registered before IncidentsController so `agents` isn't read as an incident id.
 */
@Controller('t/:tenantId/incidents')
@UseGuards(TenantGuard)
export class IncidentAgentsController {
  constructor(
    private readonly agents: IncidentAgentsService,
    private readonly proposals: IncidentProposalsService,
    private readonly builtin: BuiltinAgentsService,
  ) {}

  @Get('agents')
  @RequirePermission('inc:manage')
  list(@TenantCtx() t: TenantContext) {
    return this.agents.agents(t);
  }

  @Post(':id/proposals/:proposalId/decision')
  @RequirePermission('inc:manage')
  decide(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Param('proposalId') proposalId: string, @Body(new ZodBody(proposalDecisionSchema)) body: ProposalDecisionInput) {
    return this.proposals.decide(t, user, id, proposalId, body);
  }

  /** Ask an assistant to look at this incident now. */
  @Post(':id/ask')
  @RequirePermission('inc:manage')
  ask(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(askAssistantSchema)) body: AskAssistantInput) {
    return this.builtin.ask(t, user, id, body);
  }

  @Post(':id/takeover')
  @RequirePermission('inc:manage')
  takeOver(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.agents.takeOver(t, user, id);
  }

  @Post(':id/hand-back')
  @RequirePermission('inc:manage')
  handBack(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string, @Body(new ZodBody(handBackSchema)) body: HandBackInput) {
    return this.agents.handBack(t, user, id, body.agentId);
  }
}
