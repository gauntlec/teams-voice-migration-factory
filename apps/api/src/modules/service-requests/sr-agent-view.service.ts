import { Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { srAutomation, srProposalSummary, type SrProposalKind, type SrStatus } from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { SrClaimsService } from './sr-claims.service';

/**
 * What an engineer sees of assistants on a request: who holds it, whether a person took it over, whether an assistant could
 * carry it through, the proposals waiting for a decision (and how earlier ones went), and the latest What-If. Read-only, so
 * the request service can include it without depending on what carries proposals out.
 */
@Injectable()
export class SrAgentView {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly claims: SrClaimsService,
  ) {}

  async details(t: TenantContext, row: { id: string; type: import('@tvmf/shared').SrType; details: unknown; status: SrStatus; agent_hold: boolean }) {
    const s = tenantDb(this.db, t.schema);
    const [claim, proposals, whatif] = await Promise.all([
      this.claims.current(t, row.id),
      s.selectFrom('service_request_actions').selectAll().where('request_id', '=', row.id).orderBy('created_at', 'desc').limit(30).execute(),
      s.selectFrom('service_request_events').select(['body', 'meta', 'created_at', 'author_id', 'actor_type']).where('request_id', '=', row.id).where('kind', '=', 'whatif').orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
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
      automation: srAutomation(row.type, (row.details ?? {}) as Record<string, unknown>, row.status),
      whatif: whatif ? { summary: whatif.body, at: whatif.created_at, meta: whatif.meta } : null,
      proposals: proposals.map((p) => ({
        id: p.id,
        kind: p.kind as SrProposalKind,
        action_class: p.action_class,
        summary: srProposalSummary(p.kind as SrProposalKind, p.params),
        params: p.params,
        rationale: p.rationale,
        risk: p.risk,
        state: p.state === 'proposed' && new Date(p.expires_at).getTime() < now ? ('expired' as const) : p.state,
        agent_name: agents.find((a) => a.id === p.agent_id)?.name ?? 'Assistant',
        decided_by_name: p.decided_by ? (users.find((u) => u.id === p.decided_by)?.display_name ?? null) : null,
        decided_at: p.decided_at,
        decision_note: p.decision_note,
        connection_id: p.connection_id,
        error: p.error,
        result: p.result,
        created_at: p.created_at,
        expires_at: p.expires_at,
      })),
    };
  }
}
