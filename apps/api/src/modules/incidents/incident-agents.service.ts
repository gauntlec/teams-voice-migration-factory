import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { agentLabel, incReference, INC_OPEN_STATUSES } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { actorCols } from './agent-actor';
import { AgentEventsService } from './agent-events.service';
import { IncidentClaimsService } from './incident-claims.service';
import { IncidentsService } from './incidents.service';

/**
 * A person and an AI assistant on the same incident: taking it over from the assistant (which locks the
 * assistant out of writing) and handing it back. The assistant is told of both through the events feed.
 */
@Injectable()
export class IncidentAgentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly claims: IncidentClaimsService,
    private readonly incidents: IncidentsService,
    private readonly events: AgentEventsService,
  ) {}

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('incident not found');
    return row;
  }

  /** Assistants that can be given incidents on this customer (for the assign picker). */
  agents(t: TenantContext) {
    return this.incidents.assignableAgents(t);
  }

  /**
   * "Take over": the assistant's lease is revoked and it is told; it can read the incident but not change it
   * until it is handed back. The person becomes the assignee unless someone else already is.
   */
  async takeOver(t: TenantContext, user: AuthedUser, id: string) {
    const row = await this.load(t, id);
    if (!INC_OPEN_STATUSES.includes(row.status) && row.status !== 'resolved') throw new BadRequestException('This incident is finished.');
    const live = await this.claims.current(t, id);
    if (!row.assigned_agent_id && !live) throw new BadRequestException('No assistant is working this incident.');
    await this.claims.revoke(t, row, user, { hold: true });
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('incidents')
      .set({ agent_hold: true, assigned_agent_id: null, ...(row.assigned_to ? {} : { assigned_to: user.id }), updated_at: new Date().toISOString(), version: row.version + 1 })
      .where('id', '=', id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This incident was just updated by someone else. Refresh and try again.');
    if (!row.assigned_to) await tenantDb(this.db, t.schema).insertInto('incident_events').values({ incident_id: id, kind: 'assigned', body: user.displayName, ...actorCols(user), meta: JSON.stringify({ userId: user.id }) }).execute();
    await this.audit.tenant(t.schema, 'incident.taken_over', { actor: { id: user.id, email: user.email }, targetType: 'incident', targetId: id, detail: { reference: incReference(row.number) } });
    await this.events.emit(t.id, updated, 'incident.updated', { change: 'taken_over', by: 'team' });
    return { ...updated, reference: incReference(row.number) };
  }

  /** Give the incident back to an assistant: it is assigned to it and its lock is lifted. */
  async handBack(t: TenantContext, user: AuthedUser, id: string, agentId: string) {
    await this.load(t, id);
    const r = await this.incidents.assign(t, user, id, { agentId });
    const agent = (await this.incidents.assignableAgents(t)).find((a) => a.id === agentId);
    await tenantDb(this.db, t.schema)
      .insertInto('incident_events')
      .values({ incident_id: id, kind: 'claim_released', body: `${user.displayName} handed this back to ${agentLabel(agent?.name ?? 'the assistant')}.`, internal: true, ...actorCols(user), meta: JSON.stringify({ agentId, handBack: true }) })
      .execute();
    return r;
  }
}
