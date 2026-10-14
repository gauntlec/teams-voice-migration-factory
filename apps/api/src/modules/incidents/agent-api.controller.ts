import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  agentClaimSchema,
  agentDiagnosticSchema,
  agentEventsQuerySchema,
  agentHandoffSchema,
  agentHeartbeatSchema,
  agentIncidentsQuerySchema,
  agentLinkItemSchema,
  agentNoteSchema,
  agentPrioritySchema,
  agentProposalResultSchema,
  agentProposalSchema,
  agentStatusSchema,
  type AgentClaimInput,
  type AgentDiagnosticInput,
  type AgentEventsQuery,
  type AgentHandoffInput,
  type AgentHeartbeatInput,
  type AgentIncidentsQuery,
  type AgentLinkItemInput,
  type AgentNoteInput,
  type AgentPriorityInput,
  type AgentProposalInput,
  type AgentProposalResultInput,
  type AgentStatusInput,
} from '@tvmf/shared';
import { CurrentAgent, Public } from '../../auth/auth.decorators';
import type { AgentPrincipal } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { AgentAuthGuard } from './agent-auth.guard';
import { AgentApiService } from './agent-api.service';

/**
 * The AI agent API (docs/AGENTS.md): /api/agent/v1. Authenticated by an agent token, not a person's login.
 * Writes accept an `Idempotency-Key` header, and the incident-changing ones an `expectedVersion` in the body.
 */
@Controller('agent/v1')
@Public()
@UseGuards(AgentAuthGuard)
export class AgentApiController {
  constructor(private readonly svc: AgentApiService) {}

  /** Incidents across the customers this agent may work. */
  @Get('incidents')
  list(@CurrentAgent() agent: AgentPrincipal, @Query(new ZodBody(agentIncidentsQuerySchema)) q: AgentIncidentsQuery) {
    return this.svc.list(agent, q);
  }

  /** The events feed: poll with ?after=<last id you saw>. */
  @Get('events')
  feed(@CurrentAgent() agent: AgentPrincipal, @Query(new ZodBody(agentEventsQuerySchema)) q: AgentEventsQuery) {
    return this.svc.feed(agent, q);
  }

  @Get('incidents/:tenantId/:id')
  get(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(agent, tenantId, id);
  }

  @Post('incidents/:tenantId/:id/claim')
  claim(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentClaimSchema)) body: AgentClaimInput, @Headers('idempotency-key') key?: string) {
    return this.svc.claim(agent, tenantId, id, body, key);
  }

  @Post('incidents/:tenantId/:id/claim/heartbeat')
  heartbeat(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentHeartbeatSchema)) body: AgentHeartbeatInput) {
    return this.svc.heartbeat(agent, tenantId, id, body);
  }

  @Delete('incidents/:tenantId/:id/claim')
  release(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.release(agent, tenantId, id);
  }

  @Post('incidents/:tenantId/:id/notes')
  note(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentNoteSchema)) body: AgentNoteInput, @Headers('idempotency-key') key?: string) {
    return this.svc.note(agent, tenantId, id, body, key);
  }

  @Post('incidents/:tenantId/:id/status')
  status(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentStatusSchema)) body: AgentStatusInput, @Headers('idempotency-key') key?: string) {
    return this.svc.status(agent, tenantId, id, body, key);
  }

  @Post('incidents/:tenantId/:id/priority')
  priority(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentPrioritySchema)) body: AgentPriorityInput, @Headers('idempotency-key') key?: string) {
    return this.svc.priority(agent, tenantId, id, body, key);
  }

  @Post('incidents/:tenantId/:id/items')
  linkItem(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentLinkItemSchema)) body: AgentLinkItemInput, @Headers('idempotency-key') key?: string) {
    return this.svc.linkItem(agent, tenantId, id, body, key);
  }

  @Post('incidents/:tenantId/:id/proposals')
  propose(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentProposalSchema)) body: AgentProposalInput, @Headers('idempotency-key') key?: string) {
    return this.svc.propose(agent, tenantId, id, body, key);
  }

  @Get('incidents/:tenantId/:id/proposals')
  listProposals(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.listProposals(agent, tenantId, id);
  }

  @Post('incidents/:tenantId/:id/proposals/:proposalId/result')
  proposalResult(
    @CurrentAgent() agent: AgentPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body(new ZodBody(agentProposalResultSchema)) body: AgentProposalResultInput,
  ) {
    return this.svc.proposalResult(agent, tenantId, id, proposalId, body);
  }

  @Get('incidents/:tenantId/:id/diagnostics')
  listDiagnostics(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.listDiagnostics(agent, tenantId, id);
  }

  @Post('incidents/:tenantId/:id/diagnostics')
  diagnostic(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentDiagnosticSchema)) body: AgentDiagnosticInput, @Headers('idempotency-key') key?: string) {
    return this.svc.diagnostic(agent, tenantId, id, body, key);
  }

  @Post('incidents/:tenantId/:id/handoff')
  handoff(@CurrentAgent() agent: AgentPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(agentHandoffSchema)) body: AgentHandoffInput, @Headers('idempotency-key') key?: string) {
    return this.svc.handoff(agent, tenantId, id, body, key);
  }
}
