import { ForbiddenException, Injectable } from '@nestjs/common';
import { tenantDb, platformDb } from '@tvmf/db';
import { INC_OPEN_STATUSES, INC_PRIORITIES, incCategoryLabel, incProblemReference, incSlaFor, type IncClock, type IncPriority, type IncSettings } from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { isSiteScoped } from '../data-collection/site-scope';

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const ms = (v: string | Date | null) => (v ? new Date(v).getTime() : null);
/** A hold that stopped the clocks isn't the team's time. */
const workedMs = (from: string | Date, to: string | Date, pausedSeconds: number) => Math.max(0, new Date(to).getTime() - new Date(from).getTime() - pausedSeconds * 1000);

/** Cap on the incidents read for a report, so one very busy month can't make it slow. */
const REPORT_LIMIT = 5000;

/**
 * The incident report for a period (docs/INCIDENT-MANAGEMENT.md, section 5): how many were
 * raised and resolved, how fast we acknowledged and restored, how often targets were met,
 * where incidents come from (priority, category, site), repeat incidents and problems, and
 * today's open backlog by age. A site contact only counts their own sites. Customers don't
 * get the problem records, which are the team's working notes.
 */
@Injectable()
export class IncidentReportService {
  constructor(@InjectDb() private readonly db: Db) {}

  async report(t: TenantContext, from: string, to: string, canManage: boolean) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
    const s = tenantDb(this.db, t.schema);
    const settings = ((await platformDb(this.db).selectFrom('tenants').select('inc_settings').where('id', '=', t.id).executeTakeFirst())?.inc_settings ?? {}) as IncSettings;
    let q = s
      .selectFrom('incidents as i')
      .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
      .select([
        'i.id as id', 'i.number as number', 'i.title as title', 'i.category as category', 'i.subcategory as subcategory', 'i.priority as priority', 'i.status as status',
        'i.site_id as site_id', 'ds.sitecode as sitecode', 'i.created_at as created_at', 'i.acknowledged_at as acknowledged_at', 'i.restored_at as restored_at',
        'i.resolved_at as resolved_at', 'i.reopened_at as reopened_at', 'i.paused_since as paused_since', 'i.paused_seconds as paused_seconds', 'i.pause_log as pause_log',
        'i.major as major', 'i.major_declared_at as major_declared_at', 'i.problem_id as problem_id',
      ])
      .where((eb) => eb.or([eb.and([eb('i.created_at', '>=', from), eb('i.created_at', '<', to)]), eb.and([eb('i.resolved_at', '>=', from), eb('i.resolved_at', '<', to)]), eb('i.status', 'in', [...INC_OPEN_STATUSES])]))
      .orderBy('i.number', 'desc')
      .limit(REPORT_LIMIT);
    if (isSiteScoped(t)) q = q.where('i.site_id', 'in', t.siteScope);
    const rows = await q.execute();

    const t0 = new Date(from).getTime();
    const t1 = new Date(to).getTime();
    const inWindow = (v: string | Date | null) => {
      const x = ms(v);
      return x !== null && x >= t0 && x < t1;
    };
    const raised = rows.filter((r) => inWindow(r.created_at));
    const resolved = rows.filter((r) => inWindow(r.resolved_at));

    const count = <K extends string>(items: typeof rows, key: (r: (typeof rows)[number]) => K) => {
      const m = new Map<K, number>();
      for (const r of items) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    // How often each target was met, among the incidents raised in the period. One still running and
    // already late counts as missed; one that is still on time is left out until it finishes.
    const clocks = { response: { met: 0, missed: 0 }, restoration: { met: 0, missed: 0 }, resolution: { met: 0, missed: 0 } };
    for (const r of raised) {
      const sla = incSlaFor(r, settings);
      for (const w of ['response', 'restoration', 'resolution'] as const) {
        const c: IncClock = sla[w];
        if (c.state === 'met') clocks[w].met++;
        else if (c.state === 'missed' || c.state === 'overdue') clocks[w].missed++;
      }
    }
    const onTime = (w: keyof typeof clocks) => {
      const { met, missed } = clocks[w];
      return { met, missed, percent: met + missed === 0 ? null : Math.round((met / (met + missed)) * 100) };
    };

    const hours = (xs: number[]) => {
      const m = median(xs);
      return m === null ? null : Math.round((m / 3_600_000) * 10) / 10;
    };
    const minutes = (xs: number[]) => {
      const m = median(xs);
      return m === null ? null : Math.round(m / 60_000);
    };

    const now = Date.now();
    const open = rows.filter((r) => INC_OPEN_STATUSES.includes(r.status));
    const age = (r: (typeof rows)[number]) => (now - new Date(r.created_at).getTime()) / 86_400_000;
    const backlog = { under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 };
    for (const r of open) {
      const d = age(r);
      if (d < 1) backlog.under1d++;
      else if (d < 3) backlog.d1to3++;
      else if (d < 7) backlog.d3to7++;
      else backlog.over7d++;
    }

    // The same kind of problem at the same place, again and again.
    const repeatMap = new Map<string, { category: string; sitecode: string | null; refs: string[] }>();
    for (const r of raised) {
      const key = `${r.category}|${r.site_id ?? ''}`;
      const e = repeatMap.get(key) ?? { category: r.category, sitecode: r.sitecode, refs: [] };
      e.refs.push(`INC-${String(r.number).padStart(4, '0')}`);
      repeatMap.set(key, e);
    }
    const repeats = [...repeatMap.values()]
      .filter((e) => e.refs.length >= 3)
      .sort((a, b) => b.refs.length - a.refs.length)
      .slice(0, 5)
      .map((e) => ({ category: e.category, category_label: incCategoryLabel(e.category), sitecode: e.sitecode, count: e.refs.length, references: e.refs.slice(0, 6) }));

    let problems: { id: string; reference: string; title: string; count: number }[] | undefined;
    if (canManage) {
      const counts = count(raised.filter((r) => r.problem_id), (r) => r.problem_id!);
      const found = counts.length ? await s.selectFrom('problems').select(['id', 'number', 'title']).where('id', 'in', counts.map(([id]) => id)).execute() : [];
      problems = counts.slice(0, 5).flatMap(([id, n]) => {
        const p = found.find((x) => x.id === id);
        return p ? [{ id, reference: incProblemReference(p.number), title: p.title, count: n }] : [];
      });
    }

    // Who fixed the incidents resolved in the period: an assistant alone, a person with an assistant's help, or a person alone.
    const resolvedIds = resolved.map((r) => r.id);
    const touched = resolvedIds.length
      ? await s
          .selectFrom('incident_events')
          .select(['incident_id', 'kind', 'actor_type', 'meta', 'created_at'])
          .where('incident_id', 'in', resolvedIds)
          .where((eb) => eb.or([eb('actor_type', '=', 'agent'), eb.and([eb('kind', '=', 'status_changed'), eb('to_status', '=', 'resolved')])]))
          .orderBy('created_at')
          .execute()
      : [];
    const fixedBy = { agent: 0, person_with_agent: 0, person: 0 };
    for (const r of resolved) {
      const mine = touched.filter((e) => e.incident_id === r.id);
      const resolver = [...mine].reverse().find((e) => e.kind === 'status_changed');
      const agentWorked = mine.some((e) => e.actor_type === 'agent');
      if (resolver?.actor_type === 'agent') fixedBy.agent++;
      else if (agentWorked) fixedBy.person_with_agent++;
      else fixedBy.person++;
    }

    return {
      from,
      to,
      raised: raised.length,
      fixed_by: fixedBy,
      resolved: resolved.length,
      reopened: rows.filter((r) => inWindow(r.reopened_at)).length,
      major: rows.filter((r) => r.major && inWindow(r.major_declared_at)).length,
      by_priority: INC_PRIORITIES.map((p: IncPriority) => ({ priority: p, count: raised.filter((r) => r.priority === p).length })),
      by_category: count(raised, (r) => r.category).map(([category, n]) => ({ category, label: incCategoryLabel(category), count: n })),
      by_site: count(raised, (r) => r.sitecode ?? 'All sites').map(([site, n]) => ({ site, count: n })),
      median_minutes_to_acknowledge: minutes(raised.filter((r) => r.acknowledged_at).map((r) => workedMs(r.created_at, r.acknowledged_at!, 0))),
      median_hours_to_restore: hours(raised.filter((r) => r.restored_at ?? r.resolved_at).map((r) => workedMs(r.created_at, (r.restored_at ?? r.resolved_at)!, r.paused_seconds))),
      median_hours_to_resolve: hours(resolved.map((r) => workedMs(r.created_at, r.resolved_at!, r.paused_seconds))),
      on_time: { response: onTime('response'), restoration: onTime('restoration'), resolution: onTime('resolution') },
      backlog,
      repeats,
      problems,
      truncated: rows.length >= REPORT_LIMIT,
    };
  }
}
