import { BadRequestException, Injectable } from '@nestjs/common';
import { platformDb, tenantDb, tenantSchemaName } from '@tvmf/db';
import {
  INC_OPEN_STATUSES,
  INC_PRIORITIES,
  incPriority,
  incReference,
  intakeDedupKey,
  intakeIncidentFields,
  intakeWanted,
  normaliseIntakeBody,
  type IntakeAlert,
} from '@tvmf/shared';
import type { IntakePrincipal, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { intakeActor } from './intake-actor';
import { IncidentsService } from './incidents.service';

/** An alert that fires again is noted at most this often, so a chatty tool does not fill the timeline. */
const NOTE_EVERY_MS = 10 * 60_000;
const RESOLVED_OR_OPEN = [...INC_OPEN_STATUSES, 'resolved'] as const;

export interface IntakeResult {
  action: 'created' | 'updated' | 'resolved' | 'ignored';
  incident: string | null;
  reason?: string;
}

/**
 * Monitoring alerts (docs/INTAKE.md). The same alert (the same key) is one incident however many times it fires: the first raises
 * it, repeats note it (and raise its priority if they are worse), and "resolved" notes that it cleared, moving the incident to
 * Restored when the source is set to. Alerts are raised by the source, as a system actor: no person is the reporter, and no
 * "we've got it" email goes anywhere. The team is emailed like for any new incident.
 */
@Injectable()
export class IncidentIntakeService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly incidents: IncidentsService,
  ) {}

  private async tenant(tenantId: string): Promise<TenantContext> {
    const row = await platformDb(this.db).selectFrom('tenants').select(['id', 'slug', 'name', 'schema_name', 'status', 'teams_read_only', 'managed_services_enabled']).where('id', '=', tenantId).executeTakeFirst();
    if (!row || row.status !== 'active' || !row.managed_services_enabled) throw new BadRequestException('Incidents are not switched on for this customer.');
    return { id: row.id, slug: row.slug, name: row.name, schema: row.schema_name || tenantSchemaName(row.id), siteScope: null, teamsReadOnly: row.teams_read_only, managedServices: true };
  }

  async alert(source: IntakePrincipal, body: unknown): Promise<IntakeResult> {
    const n = normaliseIntakeBody(source.kind, body);
    if (!n.ok) throw new BadRequestException(n.error);
    const alert = n.alert;
    const t = await this.tenant(source.tenantId);
    const actor = intakeActor({ id: source.sourceId, name: source.name });
    const s = tenantDb(this.db, t.schema);
    const key = intakeDedupKey(source.sourceId, alert.dedupKey);
    await platformDb(this.db)
      .updateTable('intake_sources')
      .set({ last_used_at: new Date().toISOString(), alerts_received: (eb) => eb('alerts_received', '+', 1) })
      .where('id', '=', source.sourceId)
      .execute();

    const open = await s.selectFrom('incidents').selectAll().where('dedup_key', '=', key).where('status', 'in', [...RESOLVED_OR_OPEN]).executeTakeFirst();

    if (alert.state === 'resolved') {
      if (!open) return { action: 'ignored', incident: null, reason: 'nothing open for that key' };
      await this.incidents.comment(t, actor, open.id, { body: `The alert cleared in ${source.name}${alert.description ? `: ${alert.description}` : '.'}`, internal: true }, true);
      if (source.config.autoRestore && ['in_progress', 'on_hold'].includes(open.status)) {
        await this.incidents.move(t, actor, open.id, { to: 'restored', note: `${source.name} reports the problem has cleared. Service looks restored: confirm with the customer before resolving.` }, true).catch(() => undefined);
      }
      return { action: 'resolved', incident: incReference(open.number) };
    }

    if (!intakeWanted(source.config, alert.severity)) return { action: 'ignored', incident: null, reason: `below the minimum severity (${source.config.minSeverity})` };
    const f = intakeIncidentFields(source.kind, source.config, alert);

    if (open) {
      await this.fireAgain(t, actor, source, open, alert, f);
      return { action: 'updated', incident: incReference(open.number) };
    }

    const site = f.siteCode ? await s.selectFrom('discovery_sites').select('id').where(({ eb }) => eb(eb.fn('lower', ['sitecode']), '=', f.siteCode!.toLowerCase())).executeTakeFirst() : undefined;
    const { created, row } = await this.incidents.createFromIntake(t, actor, {
      title: f.title,
      description: f.siteCode && !site ? `${f.description}\n(Site ${f.siteCode} is not known to Voxshift.)` : f.description,
      category: f.category,
      impact: f.impact,
      urgency: f.urgency,
      siteId: site?.id ?? null,
      source: 'monitor',
      dedupKey: key,
      reporterId: source.sourceId,
      staffRaised: true,
      details: { source: source.name, kind: source.kind, severity: alert.severity, ...(alert.link ? { link: alert.link } : {}), count: 1, firstAt: new Date().toISOString() },
    });
    return { action: created ? 'created' : 'updated', incident: row.reference };
  }

  /** The same alert again: count it, note it (not too often), raise the priority if it is worse than the incident's, reopen a resolved one. */
  private async fireAgain(t: TenantContext, actor: ReturnType<typeof intakeActor>, source: IntakePrincipal, open: { id: string; number: number; status: string; priority: (typeof INC_PRIORITIES)[number]; priority_overridden: boolean; details: unknown; category: string; updated_at: string }, alert: IntakeAlert, f: ReturnType<typeof intakeIncidentFields>) {
    const s = tenantDb(this.db, t.schema);
    const details = (open.details ?? {}) as { intake?: Record<string, unknown> } & Record<string, unknown>;
    const intake = { ...(details.intake ?? {}), count: Number(details.intake?.count ?? 1) + 1, lastAt: new Date().toISOString() };
    await s.updateTable('incidents').set({ details: JSON.stringify({ ...details, intake }) }).where('id', '=', open.id).execute();

    const last = await s.selectFrom('incident_events').select('created_at').where('incident_id', '=', open.id).where('kind', '=', 'comment').where('actor_type', '=', 'system').where('author_id', '=', source.sourceId).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    if (!last || Date.now() - new Date(last.created_at).getTime() >= NOTE_EVERY_MS) {
      await s
        .insertInto('incident_events')
        .values({ incident_id: open.id, kind: 'comment', body: `${source.name}: the alert fired again (${intake.count} times so far).${alert.description ? ` ${alert.description.slice(0, 500)}` : ''}`, internal: true, author_id: source.sourceId, actor_type: 'system' })
        .execute();
    }
    // A worse alert raises the priority, unless the team has set it by hand.
    const wanted = incPriority(f.impact, f.urgency, f.category).priority;
    if (!open.priority_overridden && INC_PRIORITIES.indexOf(wanted) < INC_PRIORITIES.indexOf(open.priority) && ['new', 'in_progress', 'on_hold'].includes(open.status)) {
      await this.incidents.setPriority(t, actor, open.id, { priority: wanted, reason: `${source.name} now reports it as ${alert.severity}.` }).catch(() => undefined);
    }
    if (open.status === 'resolved') {
      await this.incidents.move(t, actor, open.id, { to: 'in_progress', note: `${source.name}: the alert fired again after the incident was resolved.` }, true).catch(() => undefined);
    }
  }
}
