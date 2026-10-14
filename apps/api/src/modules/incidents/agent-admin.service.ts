import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { platformDb } from '@tvmf/db';
import {
  AGENT_ACTION_CLASSES,
  AGENT_LEVEL_CAPS,
  BUILTIN_AGENTS,
  agentEffectiveAutonomy,
  agentTokenHint,
  formatAgentToken,
  type AgentKillSwitchInput,
  type AgentPolicyInput,
  type CreateAgentInput,
  type CreateBuiltinAgentInput,
  type CreateAgentTokenInput,
  type CreateAgentWebhookInput,
  type UpdateAgentInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { encryptSecret, sha256 } from '../../common/crypto';
import type { AuthedUser } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

/**
 * Administering AI agents (Super Admins): who they are, their tokens (shown once), which customers they may
 * work and how far, their webhooks, and the kill switches. Everything is audited.
 */
@Injectable()
export class AgentAdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async agent(id: string) {
    const a = await platformDb(this.db).selectFrom('agents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!a) throw new NotFoundException('agent not found');
    return a;
  }

  async list() {
    const p = platformDb(this.db);
    const [agents, tokens, policies, msps] = await Promise.all([
      p.selectFrom('agents').selectAll().orderBy('name').execute(),
      p.selectFrom('agent_tokens').select(['agent_id', 'revoked_at', 'expires_at']).execute(),
      p.selectFrom('agent_customer_policy').select(['agent_id', 'enabled']).execute(),
      p.selectFrom('msps').select(['id', 'name']).execute(),
    ]);
    const now = Date.now();
    return agents.map((a) => ({
      ...a,
      msp_name: msps.find((m) => m.id === a.msp_id)?.name ?? null,
      live_tokens: tokens.filter((t) => t.agent_id === a.id && !t.revoked_at && (!t.expires_at || new Date(t.expires_at).getTime() > now)).length,
      customers: policies.filter((x) => x.agent_id === a.id && x.enabled).length,
    }));
  }

  async create(user: AuthedUser, input: CreateAgentInput) {
    try {
      const a = await platformDb(this.db)
        .insertInto('agents')
        .values({ name: input.name, kind: input.kind, description: input.description, model_label: input.modelLabel, msp_id: input.mspId ?? null, created_by: user.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.platform('agent.created', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: a.id, detail: { name: a.name, kind: a.kind } });
      return a;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('An agent with that name already exists.');
      throw e;
    }
  }

  /** Adds one of the assistants Voxshift ships. It runs inside the API, so it has no tokens; it starts with no customers. */
  async createBuiltin(user: AuthedUser, input: CreateBuiltinAgentInput) {
    const def = BUILTIN_AGENTS[input.key];
    try {
      const a = await platformDb(this.db)
        .insertInto('agents')
        .values({ name: def.name, kind: def.kind, description: def.description, model_label: def.modelLabel, builtin_key: input.key, created_by: user.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.platform('agent.created', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: a.id, detail: { name: a.name, kind: a.kind, builtin: input.key } });
      return a;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException(`${def.name} has already been added.`);
      throw e;
    }
  }

  async get(id: string) {
    const p = platformDb(this.db);
    const a = await this.agent(id);
    const [tokens, policies, webhooks, tenants] = await Promise.all([
      p.selectFrom('agent_tokens').select(['id', 'name', 'last4', 'scopes', 'ip_allow', 'expires_at', 'last_used_at', 'revoked_at', 'created_at']).where('agent_id', '=', id).orderBy('created_at', 'desc').execute(),
      p.selectFrom('agent_customer_policy').selectAll().where('agent_id', '=', id).execute(),
      p.selectFrom('agent_webhooks').select(['id', 'url', 'kinds', 'active', 'cursor', 'failures', 'last_status', 'last_delivery_at', 'created_at']).where('agent_id', '=', id).orderBy('created_at').execute(),
      p.selectFrom('tenants').select(['id', 'name', 'managed_services_enabled', 'agents_enabled']).where('status', '=', 'active').orderBy('name').execute(),
    ]);
    return {
      agent: a,
      tokens: tokens.map((t) => ({ ...t, hint: agentTokenHint(t.last4) })),
      // Every customer with Managed Services, with this agent's policy where it has one.
      customers: tenants
        .filter((t) => t.managed_services_enabled)
        .map((t) => {
          const pol = policies.find((x) => x.tenant_id === t.id);
          return { tenant_id: t.id, name: t.name, agents_enabled: t.agents_enabled, allowed: !!pol, enabled: pol?.enabled ?? false, autonomy: agentEffectiveAutonomy(pol?.autonomy) };
        }),
      webhooks: webhooks.map((w) => ({ ...w, cursor: Number(w.cursor) })),
      caps: AGENT_LEVEL_CAPS,
    };
  }

  async update(user: AuthedUser, id: string, input: UpdateAgentInput) {
    await this.agent(id);
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) set.name = input.name;
    if (input.kind !== undefined) set.kind = input.kind;
    if (input.description !== undefined) set.description = input.description;
    if (input.modelLabel !== undefined) set.model_label = input.modelLabel;
    if (input.status !== undefined) set.status = input.status;
    if (input.mspId !== undefined) set.msp_id = input.mspId;
    try {
      const a = await platformDb(this.db).updateTable('agents').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.platform('agent.updated', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, detail: { changed: Object.keys(input), status: input.status } });
      return a;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('An agent with that name already exists.');
      throw e;
    }
  }

  /** Makes a token. The full token is returned once and never stored: only a hash of its secret is. */
  async createToken(user: AuthedUser, id: string, input: CreateAgentTokenInput) {
    const a = await this.agent(id);
    if (a.builtin_key) throw new BadRequestException('This assistant runs inside Voxshift. It has no tokens.');
    const secret = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    const row = await platformDb(this.db)
      .insertInto('agent_tokens')
      .values({ agent_id: id, name: input.name, last4: secret.slice(-4), secret_hash: sha256(secret), scopes: input.scopes, ip_allow: input.ipAllow, expires_at: expires, created_by: user.id })
      .returning(['id', 'name', 'last4', 'scopes', 'expires_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('agent.token_created', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, detail: { agent: a.name, token: row.name, scopes: input.scopes, expiresInDays: input.expiresInDays, ipAllow: input.ipAllow } });
    return { id: row.id, name: row.name, hint: agentTokenHint(row.last4), scopes: row.scopes, expires_at: row.expires_at, token: formatAgentToken(row.id, secret) };
  }

  async revokeToken(user: AuthedUser, id: string, tokenId: string) {
    const r = await platformDb(this.db).updateTable('agent_tokens').set({ revoked_at: new Date().toISOString() }).where('id', '=', tokenId).where('agent_id', '=', id).where('revoked_at', 'is', null).returning('name').executeTakeFirst();
    if (!r) throw new NotFoundException('token not found');
    await this.audit.platform('agent.token_revoked', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, detail: { token: r.name } });
    return { ok: true };
  }

  /** Allows (or switches off) an agent on a customer, and sets its autonomy there. Levels above an action class's cap are refused. */
  async setPolicy(user: AuthedUser, id: string, tenantId: string, input: AgentPolicyInput) {
    const a = await this.agent(id);
    const tenant = await platformDb(this.db).selectFrom('tenants').select(['id', 'name', 'managed_services_enabled']).where('id', '=', tenantId).executeTakeFirst();
    if (!tenant) throw new NotFoundException('customer not found');
    if (!tenant.managed_services_enabled) throw new BadRequestException('Managed Services is not switched on for that customer.');
    for (const c of AGENT_ACTION_CLASSES) {
      const level = input.autonomy[c];
      if (level !== undefined && level > AGENT_LEVEL_CAPS[c]) throw new BadRequestException(`"${c}" can't go above level ${AGENT_LEVEL_CAPS[c]}.`);
    }
    await platformDb(this.db)
      .insertInto('agent_customer_policy')
      .values({ agent_id: id, tenant_id: tenantId, enabled: input.enabled, autonomy: JSON.stringify(input.autonomy), updated_by: user.id })
      .onConflict((oc) => oc.columns(['agent_id', 'tenant_id']).doUpdateSet({ enabled: input.enabled, autonomy: JSON.stringify(input.autonomy), updated_by: user.id, updated_at: new Date().toISOString() }))
      .execute();
    await this.audit.platform('agent.policy_set', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, tenantId, detail: { agent: a.name, customer: tenant.name, enabled: input.enabled, autonomy: input.autonomy } });
    return { ok: true };
  }

  async removePolicy(user: AuthedUser, id: string, tenantId: string) {
    const a = await this.agent(id);
    await platformDb(this.db).deleteFrom('agent_customer_policy').where('agent_id', '=', id).where('tenant_id', '=', tenantId).execute();
    await this.audit.platform('agent.policy_removed', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, tenantId, detail: { agent: a.name } });
    return { ok: true };
  }

  /** Adds a webhook. Its signing secret is returned once. */
  async createWebhook(user: AuthedUser, id: string, input: CreateAgentWebhookInput) {
    const a = await this.agent(id);
    if (a.builtin_key) throw new BadRequestException('This assistant runs inside Voxshift. It has no webhooks.');
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    // Start from now: an agent isn't sent the whole backlog.
    const last = await platformDb(this.db).selectFrom('agent_events').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const row = await platformDb(this.db)
      .insertInto('agent_webhooks')
      .values({ agent_id: id, url: input.url, secret_enc: encryptSecret(secret), kinds: input.kinds, cursor: last?.id ?? 0, created_by: user.id })
      .returning(['id', 'url', 'kinds'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('agent.webhook_created', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, detail: { agent: a.name, url: input.url, kinds: input.kinds } });
    return { ...row, secret };
  }

  async setWebhookActive(user: AuthedUser, id: string, webhookId: string, active: boolean) {
    const r = await platformDb(this.db)
      .updateTable('agent_webhooks')
      .set({ active, ...(active ? { failures: 0, next_attempt_at: new Date().toISOString() } : {}) })
      .where('id', '=', webhookId)
      .where('agent_id', '=', id)
      .returning('url')
      .executeTakeFirst();
    if (!r) throw new NotFoundException('webhook not found');
    await this.audit.platform('agent.webhook_toggled', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, detail: { url: r.url, active } });
    return { ok: true };
  }

  async removeWebhook(user: AuthedUser, id: string, webhookId: string) {
    const r = await platformDb(this.db).deleteFrom('agent_webhooks').where('id', '=', webhookId).where('agent_id', '=', id).returning('url').executeTakeFirst();
    if (!r) throw new NotFoundException('webhook not found');
    await this.audit.platform('agent.webhook_removed', { actor: { id: user.id, email: user.email }, targetType: 'agent', targetId: id, detail: { url: r.url } });
    return { ok: true };
  }

  async killSwitch() {
    const k = await platformDb(this.db).selectFrom('agent_kill_switch').selectAll().where('id', '=', 1).executeTakeFirst();
    return { all_disabled: k?.all_disabled ?? false, note: k?.note ?? null, changed_at: k?.changed_at ?? null };
  }

  /** Every assistant, everywhere: on or off. */
  async setKillSwitch(user: AuthedUser, input: AgentKillSwitchInput) {
    await platformDb(this.db)
      .updateTable('agent_kill_switch')
      .set({ all_disabled: input.allDisabled, note: input.note ?? null, changed_by: user.id, changed_at: new Date().toISOString() })
      .where('id', '=', 1)
      .execute();
    await this.audit.platform(input.allDisabled ? 'agent.kill_switch_on' : 'agent.kill_switch_off', { actor: { id: user.id, email: user.email }, detail: { note: input.note ?? null } });
    return this.killSwitch();
  }

  /** Every assistant on one customer: on or off. */
  async setTenantAgents(user: AuthedUser, tenantId: string, enabled: boolean) {
    const t = await platformDb(this.db).updateTable('tenants').set({ agents_enabled: enabled }).where('id', '=', tenantId).returning('name').executeTakeFirst();
    if (!t) throw new NotFoundException('customer not found');
    await this.audit.platform(enabled ? 'agent.customer_on' : 'agent.customer_off', { actor: { id: user.id, email: user.email }, tenantId, detail: { customer: t.name } });
    return { ok: true };
  }
}
