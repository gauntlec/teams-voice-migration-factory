import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  agentKillSwitchSchema,
  agentPolicySchema,
  createAgentSchema,
  createAgentTokenSchema,
  createAgentWebhookSchema,
  tenantAgentsSchema,
  updateAgentSchema,
  type AgentKillSwitchInput,
  type AgentPolicyInput,
  type CreateAgentInput,
  type CreateAgentTokenInput,
  type CreateAgentWebhookInput,
  type TenantAgentsInput,
  type UpdateAgentInput,
} from '@tvmf/shared';
import { z } from 'zod';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthedUser } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { AgentAdminService } from './agent-admin.service';

const activeSchema = z.object({ active: z.boolean() }).strict();

/** Administering AI agents: Super Admins only (agent:manage). Not tenant-scoped. */
@Controller('agents')
@RequirePermission('agent:manage')
export class AgentAdminController {
  constructor(private readonly svc: AgentAdminService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@CurrentUser() user: AuthedUser, @Body(new ZodBody(createAgentSchema)) body: CreateAgentInput) {
    return this.svc.create(user, body);
  }

  /* Fixed paths before :id. */

  @Get('kill-switch')
  killSwitch() {
    return this.svc.killSwitch();
  }

  @Put('kill-switch')
  setKillSwitch(@CurrentUser() user: AuthedUser, @Body(new ZodBody(agentKillSwitchSchema)) body: AgentKillSwitchInput) {
    return this.svc.setKillSwitch(user, body);
  }

  /** Every assistant on one customer, on or off. */
  @Put('customers/:tenantId')
  setTenantAgents(@CurrentUser() user: AuthedUser, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body(new ZodBody(tenantAgentsSchema)) body: TenantAgentsInput) {
    return this.svc.setTenantAgents(user, tenantId, body.enabled);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateAgentSchema)) body: UpdateAgentInput) {
    return this.svc.update(user, id, body);
  }

  @Post(':id/tokens')
  createToken(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(createAgentTokenSchema)) body: CreateAgentTokenInput) {
    return this.svc.createToken(user, id, body);
  }

  @Delete(':id/tokens/:tokenId')
  revokeToken(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Param('tokenId', ParseUUIDPipe) tokenId: string) {
    return this.svc.revokeToken(user, id, tokenId);
  }

  @Put(':id/policies/:tenantId')
  setPolicy(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body(new ZodBody(agentPolicySchema)) body: AgentPolicyInput) {
    return this.svc.setPolicy(user, id, tenantId, body);
  }

  @Delete(':id/policies/:tenantId')
  removePolicy(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.svc.removePolicy(user, id, tenantId);
  }

  @Post(':id/webhooks')
  createWebhook(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(createAgentWebhookSchema)) body: CreateAgentWebhookInput) {
    return this.svc.createWebhook(user, id, body);
  }

  @Patch(':id/webhooks/:webhookId')
  setWebhookActive(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Body(new ZodBody(activeSchema)) body: { active: boolean }) {
    return this.svc.setWebhookActive(user, id, webhookId, body.active);
  }

  @Delete(':id/webhooks/:webhookId')
  removeWebhook(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string, @Param('webhookId', ParseUUIDPipe) webhookId: string) {
    return this.svc.removeWebhook(user, id, webhookId);
  }
}
