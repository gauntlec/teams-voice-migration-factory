import { Injectable } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import { incReference, type AgentEventKind, type IncPriority, type IncStatus } from '@tvmf/shared';
import { InjectDb, type Db } from '../../db/db.module';

/** The incident columns an event is built from. */
export interface EventIncident {
  id: string;
  number: number;
  priority: IncPriority;
  status: IncStatus;
  version: number;
  category: string;
}

/**
 * The agents' events feed (platform.agent_events): what happened on incidents, kept small on
 * purpose - an agent reads the incident for the detail. An event is for every agent that may work
 * the customer, or (with `agentId`) for one agent only. Agents poll `list`, or the worker pushes
 * the same events to a signed webhook.
 */
@Injectable()
export class AgentEventsService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Records an event. Nothing is written when no agent is allowed on the customer (and none is targeted). */
  async emit(tenantId: string, row: EventIncident, kind: AgentEventKind, extra: Record<string, unknown> = {}, agentId: string | null = null): Promise<void> {
    try {
      if (!agentId) {
        const any = await platformDb(this.db).selectFrom('agent_customer_policy').select('agent_id').where('tenant_id', '=', tenantId).where('enabled', '=', true).limit(1).executeTakeFirst();
        if (!any) return;
      }
      await platformDb(this.db)
        .insertInto('agent_events')
        .values({
          tenant_id: tenantId,
          incident_id: row.id,
          kind,
          agent_id: agentId,
          payload: JSON.stringify({ reference: incReference(row.number), priority: row.priority, status: row.status, version: row.version, category: row.category, ...extra }),
        })
        .execute();
    } catch (e) {
      // The feed is a convenience: a problem here must never fail the change that caused it.
      // eslint-disable-next-line no-console
      console.warn(`[agents] could not record ${kind} for ${row.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Events after a cursor, for the customers this agent may work: the ones for everyone and the ones
   * for it alone, oldest first. `next` is the cursor to send back next time.
   */
  async list(agentId: string, after: number, limit: number) {
    const rows = await platformDb(this.db)
      .selectFrom('agent_events as e')
      .innerJoin('agent_customer_policy as p', (j) => j.onRef('p.tenant_id', '=', 'e.tenant_id').on('p.agent_id', '=', agentId).on('p.enabled', '=', true))
      .innerJoin('tenants as t', 't.id', 'e.tenant_id')
      .select(['e.id as id', 'e.tenant_id as tenant_id', 'e.incident_id as incident_id', 'e.kind as kind', 'e.payload as payload', 'e.created_at as created_at'])
      .where('t.agents_enabled', '=', true)
      .where('e.id', '>', String(after) as never)
      .where((eb) => eb.or([eb('e.agent_id', 'is', null), eb('e.agent_id', '=', agentId)]))
      .orderBy('e.id')
      .limit(limit)
      .execute();
    // The payload is context; the event's own fields always win.
    const events = rows.map((r) => ({ ...(r.payload as Record<string, unknown>), id: Number(r.id), tenant_id: r.tenant_id, incident_id: r.incident_id, kind: r.kind, created_at: r.created_at }));
    return { events, next: events.length ? events[events.length - 1]!.id : after };
  }
}
