import { ForbiddenException, Injectable } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { AGENT_PROPOSAL_KINDS, SR_PROPOSAL_KINDS, can, type AgentProposalState, type AssistantActivityData, type AssistantActivityRow, type Role } from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { isSiteScoped } from '../data-collection/site-scope';

const APPROVED: AgentProposalState[] = ['approved', 'running', 'done', 'failed'];
type Bucket = 'approved' | 'rejected' | 'expired' | 'waiting';
const bucketOf = (state: AgentProposalState): Bucket => (APPROVED.includes(state) ? 'approved' : state === 'rejected' ? 'rejected' : state === 'expired' ? 'expired' : 'waiting');

/**
 * The Assistant activity report's figures (docs/INSIGHTS.md): what each AI assistant did for the customer in a period.
 *
 * - Worked: incidents and service requests it claimed in the period.
 * - Proposed: steps it put to a person in the period, by how they stand now (approved covers approved, running, done and failed).
 * - Handed over / taken back: claims it ended by handing to a person, or that a person ended (take-over, reassigning).
 * - Resolved / completed: incidents it moved to resolved itself, and service requests whose verified deployment it ran.
 *
 * Incidents need inc:read and service requests sr:read; a site contact sees only their own sites' items.
 */
@Injectable()
export class InsightsAssistantsService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** `window`: ISO instants, `to` not included (insightsPeriod, reportPeriodQuery). */
  async activity(t: TenantContext, role: Role, window: { from: string; to: string }): Promise<AssistantActivityData> {
    const incidents = t.managedServices && can(role, 'inc:read');
    const serviceRequests = t.managedServices && can(role, 'sr:read');
    if (!incidents && !serviceRequests) throw new ForbiddenException('This report isn’t available for this customer, or for your role.');
    const { from, to } = window;
    const s = tenantDb(this.db, t.schema);
    const scoped = isSiteScoped(t);
    const rows = new Map<string, AssistantActivityRow>();
    const row = (agentId: string) => {
      let r = rows.get(agentId);
      if (!r) {
        r = { agentId, name: 'Assistant', builtin: false, incidentsWorked: 0, requestsWorked: 0, proposed: 0, approved: 0, rejected: 0, expired: 0, waiting: 0, handedOff: 0, takenBack: 0, resolved: 0, completed: 0 };
        rows.set(agentId, r);
      }
      return r;
    };
    const kinds = new Map<string, AssistantActivityData['proposals'][number]>();
    const decideMinutes: number[] = [];
    const countProposals = (area: 'incident' | 'service_request', list: { agent_id: string; kind: string; state: AgentProposalState; created_at: string | Date; decided_at: string | null }[]) => {
      for (const x of list) {
        const b = bucketOf(x.state);
        const r = row(x.agent_id);
        r.proposed++;
        r[b]++;
        const labels: Record<string, { label: string }> = area === 'incident' ? AGENT_PROPOSAL_KINDS : SR_PROPOSAL_KINDS;
        const k = kinds.get(`${area}:${x.kind}`) ?? { area, kind: x.kind, label: labels[x.kind]?.label ?? x.kind, proposed: 0, approved: 0, rejected: 0, expired: 0, waiting: 0 };
        k.proposed++;
        k[b]++;
        kinds.set(`${area}:${x.kind}`, k);
        if (x.decided_at && (b === 'approved' || b === 'rejected')) decideMinutes.push(Math.max(0, (new Date(x.decided_at).getTime() - new Date(x.created_at).getTime()) / 60_000));
      }
    };
    const worked = { incidents: new Set<string>(), requests: new Set<string>() };

    if (incidents) {
      const siteIds = scoped ? t.siteScope : null;
      let claims = s
        .selectFrom('incident_claims as c')
        .innerJoin('incidents as i', 'i.id', 'c.incident_id')
        .select(['c.agent_id', 'c.incident_id', 'c.started_at', 'c.released_at', 'c.release_reason']);
      if (siteIds) claims = claims.where('i.site_id', 'in', siteIds);
      for (const c of await claims.where((eb) => eb.or([eb.and([eb('c.started_at', '>=', from), eb('c.started_at', '<', to)]), eb.and([eb('c.released_at', '>=', from), eb('c.released_at', '<', to)])])).execute()) {
        const r = row(c.agent_id);
        const started = new Date(c.started_at).toISOString();
        if (started >= from && started < to) {
          r.incidentsWorked++;
          worked.incidents.add(c.incident_id);
        }
        const released = c.released_at ? new Date(c.released_at).toISOString() : null;
        if (released && released >= from && released < to) {
          if (c.release_reason === 'handed_off') r.handedOff++;
          if (c.release_reason === 'revoked') r.takenBack++;
        }
      }
      let proposals = s.selectFrom('incident_actions as a').innerJoin('incidents as i', 'i.id', 'a.incident_id').select(['a.agent_id', 'a.kind', 'a.state', 'a.created_at', 'a.decided_at']).where('a.created_at', '>=', from).where('a.created_at', '<', to);
      if (siteIds) proposals = proposals.where('i.site_id', 'in', siteIds);
      countProposals('incident', await proposals.execute());
      let resolved = s
        .selectFrom('incident_events as e')
        .innerJoin('incidents as i', 'i.id', 'e.incident_id')
        .select(['e.author_id'])
        .where('e.actor_type', '=', 'agent')
        .where('e.kind', '=', 'status_changed')
        .where('e.to_status', '=', 'resolved')
        .where('e.created_at', '>=', from)
        .where('e.created_at', '<', to);
      if (siteIds) resolved = resolved.where('i.site_id', 'in', siteIds);
      for (const e of await resolved.execute()) if (e.author_id) row(e.author_id).resolved++;
    }

    if (serviceRequests) {
      const siteIds = scoped ? t.siteScope : null;
      let claims = s
        .selectFrom('service_request_claims as c')
        .innerJoin('service_requests as r', 'r.id', 'c.request_id')
        .select(['c.agent_id', 'c.request_id', 'c.started_at', 'c.released_at', 'c.release_reason']);
      if (siteIds) claims = claims.where('r.site_id', 'in', siteIds);
      for (const c of await claims.where((eb) => eb.or([eb.and([eb('c.started_at', '>=', from), eb('c.started_at', '<', to)]), eb.and([eb('c.released_at', '>=', from), eb('c.released_at', '<', to)])])).execute()) {
        const r = row(c.agent_id);
        const started = new Date(c.started_at).toISOString();
        if (started >= from && started < to) {
          r.requestsWorked++;
          worked.requests.add(c.request_id);
        }
        const released = c.released_at ? new Date(c.released_at).toISOString() : null;
        if (released && released >= from && released < to) {
          if (c.release_reason === 'handed_off') r.handedOff++;
          if (c.release_reason === 'revoked') r.takenBack++;
        }
      }
      let proposals = s
        .selectFrom('service_request_actions as a')
        .innerJoin('service_requests as r', 'r.id', 'a.request_id')
        .select(['a.agent_id', 'a.kind', 'a.state', 'a.created_at', 'a.decided_at'])
        .where('a.created_at', '>=', from)
        .where('a.created_at', '<', to);
      if (siteIds) proposals = proposals.where('r.site_id', 'in', siteIds);
      countProposals('service_request', await proposals.execute());
      let completed = s
        .selectFrom('service_request_events as e')
        .innerJoin('service_requests as r', 'r.id', 'e.request_id')
        .select(['e.author_id'])
        .where('e.actor_type', '=', 'agent')
        .where('e.kind', '=', 'status_changed')
        .where('e.to_status', '=', 'deployed')
        .where('e.created_at', '>=', from)
        .where('e.created_at', '<', to);
      if (siteIds) completed = completed.where('r.site_id', 'in', siteIds);
      for (const e of await completed.execute()) if (e.author_id) row(e.author_id).completed++;
    }

    if (rows.size) {
      const agents = await this.db.withSchema('platform').selectFrom('agents').select(['id', 'name', 'builtin_key']).where('id', 'in', [...rows.keys()]).execute();
      for (const a of agents) {
        const r = rows.get(a.id)!;
        r.name = a.name;
        r.builtin = !!a.builtin_key;
      }
    }
    decideMinutes.sort((a, b) => a - b);
    const mid = decideMinutes.length >> 1;
    const median = decideMinutes.length ? (decideMinutes.length % 2 ? decideMinutes[mid]! : (decideMinutes[mid - 1]! + decideMinutes[mid]!) / 2) : null;
    return {
      from,
      to,
      incidents,
      serviceRequests,
      incidentsWorked: worked.incidents.size,
      requestsWorked: worked.requests.size,
      assistants: [...rows.values()].sort((a, b) => b.incidentsWorked + b.requestsWorked + b.proposed - (a.incidentsWorked + a.requestsWorked + a.proposed) || a.name.localeCompare(b.name)),
      proposals: [...kinds.values()].sort((a, b) => b.proposed - a.proposed || a.label.localeCompare(b.label)),
      medianMinutesToDecide: median === null ? null : Math.round(median),
    };
  }
}
