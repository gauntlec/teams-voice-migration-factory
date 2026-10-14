import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { SR_OPEN_STATUSES, agentLabel, srReference } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { AgentEventsService } from '../incidents/agent-events.service';
import { ServiceRequestsService } from './service-requests.service';
import { SrClaimsService } from './sr-claims.service';

/**
 * A person and an assistant on the same request: taking it over from the assistant (which locks the assistant out of
 * writing) and handing it back. The assistant is told of both through the events feed.
 */
@Injectable()
export class SrAgentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly claims: SrClaimsService,
    private readonly requests: ServiceRequestsService,
    private readonly events: AgentEventsService,
  ) {}

  private async load(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('service_requests').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('service request not found');
    return row;
  }

  /** Assistants that can be given requests on this customer (for the assign picker and Ask). */
  agents(t: TenantContext) {
    return this.requests.assignableAgents(t);
  }

  /** "Take over": the assistant's lease is revoked and it is told; it can read the request but not change it until it is handed back. */
  async takeOver(t: TenantContext, user: AuthedUser, id: string) {
    const row = await this.load(t, id);
    if (!SR_OPEN_STATUSES.includes(row.status)) throw new BadRequestException('This request is finished.');
    const live = await this.claims.current(t, id);
    if (!row.assigned_agent_id && !live) throw new BadRequestException('No assistant is working this request.');
    await this.claims.revoke(t, row, user, { hold: true });
    const updated = await tenantDb(this.db, t.schema)
      .updateTable('service_requests')
      .set({ agent_hold: true, assigned_agent_id: null, ...(row.assigned_to ? {} : { assigned_to: user.id }), updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ConflictException('This request was just updated by someone else. Refresh and try again.');
    if (!row.assigned_to) await tenantDb(this.db, t.schema).insertInto('service_request_events').values({ request_id: id, kind: 'assigned', body: user.displayName, author_id: user.id, actor_type: 'user' }).execute();
    await this.audit.tenant(t.schema, 'service_request.taken_over', { actor: { id: user.id, email: user.email }, targetType: 'service_request', targetId: id, detail: { reference: srReference(row.number) } });
    await this.events.emitRequest(t.id, updated, 'sr.updated', { change: 'taken_over', by: 'team' });
    return { ...updated, reference: srReference(row.number) };
  }

  /** Give the request back to an assistant: it is assigned to it and its lock is lifted. */
  async handBack(t: TenantContext, user: AuthedUser, id: string, agentId: string) {
    await this.load(t, id);
    const r = await this.requests.assign(t, user, id, null, agentId);
    const agent = (await this.requests.assignableAgents(t)).find((a) => a.id === agentId);
    await tenantDb(this.db, t.schema)
      .insertInto('service_request_events')
      .values({ request_id: id, kind: 'claim_released', body: `${user.displayName} handed this back to ${agentLabel(agent?.name ?? 'the assistant')}.`, internal: true, author_id: user.id, actor_type: 'user', meta: JSON.stringify({ agentId, handBack: true }) })
      .execute();
    return r;
  }
}
