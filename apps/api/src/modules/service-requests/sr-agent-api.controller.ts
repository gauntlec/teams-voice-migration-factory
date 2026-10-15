import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  agentClaimSchema,
  agentHandoffSchema,
  agentHeartbeatSchema,
  agentProposalResultSchema,
  srAgentListSchema,
  srAgentNoteSchema,
  srAgentStatusSchema,
  srAgentStepSchema,
  srProposalSchema,
  type AgentClaimInput,
  type AgentHandoffInput,
  type AgentHeartbeatInput,
  type AgentProposalResultInput,
  type SrAgentListInput,
  type SrAgentNoteInput,
  type SrAgentStatusInput,
  type SrAgentStepInput,
  type SrProposalInput,
} from '@tvmf/shared';
import { CurrentAgent, Public } from '../../auth/auth.decorators';
import type { AgentPrincipal } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { AgentArea } from '../incidents/agent-area.decorator';
import { AgentAuthGuard } from '../incidents/agent-auth.guard';
import { SrAgentApiService } from './sr-agent-api.service';

const T = ParseUUIDPipe;

/**
 * Service requests in the AI agent API (docs/SERVICE-REQUEST-AGENTS.md): /api/agent/v1/service-requests. The same token,
 * Idempotency-Key and autonomy rules as the incident endpoints.
 */
@Controller('agent/v1/service-requests')
@Public()
@UseGuards(AgentAuthGuard)
@AgentArea('service_requests')
export class SrAgentApiController {
  constructor(private readonly svc: SrAgentApiService) {}

  @Get()
  list(@CurrentAgent() agent: AgentPrincipal, @Query(new ZodBody(srAgentListSchema)) q: SrAgentListInput) {
    return this.svc.list(agent, q);
  }

  @Get(':tenantId/:id')
  get(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string) {
    return this.svc.get(agent, tenantId, id);
  }

  @Post(':tenantId/:id/claim')
  claim(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(agentClaimSchema)) body: AgentClaimInput, @Headers('idempotency-key') key?: string) {
    return this.svc.claim(agent, tenantId, id, body, key);
  }

  @Post(':tenantId/:id/claim/heartbeat')
  heartbeat(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(agentHeartbeatSchema)) body: AgentHeartbeatInput) {
    return this.svc.heartbeat(agent, tenantId, id, body);
  }

  @Delete(':tenantId/:id/claim')
  release(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string) {
    return this.svc.release(agent, tenantId, id);
  }

  @Post(':tenantId/:id/notes')
  note(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(srAgentNoteSchema)) body: SrAgentNoteInput, @Headers('idempotency-key') key?: string) {
    return this.svc.note(agent, tenantId, id, body, key);
  }

  @Post(':tenantId/:id/status')
  status(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(srAgentStatusSchema)) body: SrAgentStatusInput, @Headers('idempotency-key') key?: string) {
    return this.svc.status(agent, tenantId, id, body, key);
  }

  @Post(':tenantId/:id/apply')
  apply(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(srAgentStepSchema)) body: SrAgentStepInput, @Headers('idempotency-key') key?: string) {
    return this.svc.apply(agent, tenantId, id, body, key);
  }

  @Post(':tenantId/:id/what-if')
  whatIf(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(srAgentStepSchema)) body: SrAgentStepInput, @Headers('idempotency-key') key?: string) {
    return this.svc.whatIf(agent, tenantId, id, body, key);
  }

  @Post(':tenantId/:id/deploy')
  deploy(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(srAgentStepSchema)) body: SrAgentStepInput, @Headers('idempotency-key') key?: string) {
    return this.svc.deploy(agent, tenantId, id, body, key);
  }

  @Post(':tenantId/:id/proposals')
  propose(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(srProposalSchema)) body: SrProposalInput, @Headers('idempotency-key') key?: string) {
    return this.svc.propose(agent, tenantId, id, body, key);
  }

  @Get(':tenantId/:id/proposals')
  listProposals(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string) {
    return this.svc.listProposals(agent, tenantId, id);
  }

  @Post(':tenantId/:id/proposals/:proposalId/result')
  proposalResult(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Param('proposalId', T) proposalId: string, @Body(new ZodBody(agentProposalResultSchema)) body: AgentProposalResultInput) {
    return this.svc.proposalResult(agent, tenantId, id, proposalId, body);
  }

  @Post(':tenantId/:id/handoff')
  handoff(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', T) tenantId: string, @Param('id', T) id: string, @Body(new ZodBody(agentHandoffSchema)) body: AgentHandoffInput, @Headers('idempotency-key') key?: string) {
    return this.svc.handoff(agent, tenantId, id, body, key);
  }
}
