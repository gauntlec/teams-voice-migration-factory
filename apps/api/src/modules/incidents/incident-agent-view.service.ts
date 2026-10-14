import { Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { agentProposalSummary, type AgentProposalKind } from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { IncidentClaimsService } from './incident-claims.service';

/**
 * What an engineer sees of an AI assistant's work on an incident: who holds it, whether a person
 * took it over, and the proposals waiting for a decision (and how earlier ones went). Read-only,
 * so the incident service can include it without depending on the thing that carries proposals out.
 */
@Injectable()
export class IncidentAgentView {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly claims: IncidentClaimsService,
  ) {}

  async details(t: TenantContext, row: { id: string; agent_hold: boolean; assigned_agent_id: string | null }) {
    const [claim, proposals] = await Promise.all([
      this.claims.current(t, row.id),
      tenantDb(this.db, t.schema).selectFrom('incident_actions').selectAll().where('incident_id', '=', row.id).orderBy('created_at', 'desc').limit(30).execute(),
    ]);
    const agentIds = [...new Set(proposals.map((p) => p.agent_id))];
    const userIds = [...new Set(proposals.map((p) => p.decided_by).filter((v): v is string => !!v))];
    const [agents, users] = await Promise.all([
      agentIds.length ? platformDb(this.db).selectFrom('agents').select(['id', 'name']).where('id', 'in', agentIds).execute() : [],
      userIds.length ? platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', userIds).execute() : [],
    ]);
    const now = Date.now();
    return {
      hold: row.agent_hold,
      claim: claim ? { agent_id: claim.agent_id, agent_name: claim.agent_name, expires_at: claim.expires_at, started_at: claim.started_at, note: claim.note } : null,
      proposals: proposals.map((p) => ({
        id: p.id,
        kind: p.kind as AgentProposalKind,
        action_class: p.action_class,
        summary: agentProposalSummary(p.kind as AgentProposalKind, p.params),
        params: p.params,
        rationale: p.rationale,
        risk: p.risk,
        // A proposal nobody decided in time reads as expired even before the sweep records it.
        state: p.state === 'proposed' && new Date(p.expires_at).getTime() < now ? 'expired' : p.state,
        agent_id: p.agent_id,
        agent_name: agents.find((a) => a.id === p.agent_id)?.name ?? 'Unknown agent',
        decided_by_name: users.find((u) => u.id === p.decided_by)?.display_name ?? null,
        decided_at: p.decided_at,
        decision_note: p.decision_note,
        result: p.result,
        error: p.error,
        created_at: p.created_at,
        expires_at: p.expires_at,
      })),
    };
  }
}
