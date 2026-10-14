import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  DIAG_RECENT_DAYS,
  DIAG_RUNBOOKS,
  agentLabel,
  diagNormaliseNumber,
  diagSameNumber,
  diagSuggest,
  evalChanges,
  evalEmergency,
  evalNumber,
  evalQueue,
  evalRouting,
  evalUserVoice,
  srReference,
  type DiagDirectoryUser,
  type DiagResult,
  type DiagRunInput,
  type DiagSuggestion,
  type IncDetails,
} from '@tvmf/shared';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { actorCols } from './agent-actor';

type Rec = Record<string, unknown>;
type S = ReturnType<typeof tenantDb>;

export interface StoredDiagnostic extends DiagResult {
  id: string;
  input: string;
  created_at: string;
  actor_type: 'user' | 'agent' | 'system';
  run_by: string | null;
  run_by_name: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const idOf = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return str((v as Rec).ObjectId) ?? str((v as Rec).Id) ?? str((v as Rec).Identity);
  return null;
};
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** The last digits of a number: enough to find it in a column whatever the formatting. */
const tail = (n: string) => diagNormaliseNumber(n).replace(/\D/g, '').slice(-9);
const clean = (n: string | null) => (n ? n.replace(/^tel:/i, '').split(';')[0]! : null);

/**
 * Read-only diagnostic runbooks (packages/shared/src/diagnostics.ts; docs/DIAGNOSTICS.md). They look at what
 * Discovery and the design already hold - never at the live tenant - so they are instant, cannot change anything,
 * and every result says how old its data is. A run is kept on the incident and noted on its timeline (internal).
 */
@Injectable()
export class IncidentDiagnosticsService {
  constructor(@InjectDb() private readonly db: Db) {}

  /* ------------------------------ running ------------------------------ */

  /** Runs one check for an incident, stores the result and notes it on the timeline. */
  async run(t: TenantContext, actor: AuthedUser, incidentId: string, input: DiagRunInput, opts: { proposalId?: string } = {}): Promise<StoredDiagnostic> {
    const s = tenantDb(this.db, t.schema);
    const inc = await s.selectFrom('incidents').select(['id', 'site_id']).where('id', '=', incidentId).executeTakeFirst();
    if (!inc) throw new NotFoundException('incident not found');
    const subjectInput = DIAG_RUNBOOKS[input.runbook].input === 'none' ? '' : (input.input ?? '').trim();
    const result = await this.check(t, input.runbook, subjectInput, inc.site_id);

    const cols = actorCols(actor);
    const stored = await s
      .insertInto('incident_diagnostics')
      .values({
        incident_id: incidentId,
        runbook: input.runbook,
        input: subjectInput,
        subject: result.subject,
        status: result.status,
        summary: result.summary,
        findings: JSON.stringify(result.findings),
        data_as_of: result.dataAsOf,
        actor_type: cols.actor_type,
        run_by: cols.author_id,
        proposal_id: opts.proposalId ?? null,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
    await s
      .insertInto('incident_events')
      .values({
        incident_id: incidentId,
        kind: 'diagnostic',
        body: `${DIAG_RUNBOOKS[input.runbook].label}: ${result.summary}`,
        internal: true,
        ...cols,
        meta: JSON.stringify({ diagnosticId: stored.id, runbook: input.runbook, status: result.status }),
      })
      .execute();
    return { ...result, id: stored.id, input: subjectInput, created_at: stored.created_at, actor_type: cols.actor_type, run_by: cols.author_id, run_by_name: actor.displayName };
  }

  /** What has been run on an incident, newest first. */
  async list(t: TenantContext, incidentId: string, limit = 30): Promise<StoredDiagnostic[]> {
    const rows = await tenantDb(this.db, t.schema).selectFrom('incident_diagnostics').selectAll().where('incident_id', '=', incidentId).orderBy('created_at', 'desc').limit(limit).execute();
    const userIds = [...new Set(rows.filter((r) => r.actor_type === 'user' && r.run_by).map((r) => r.run_by!))];
    const agentIds = [...new Set(rows.filter((r) => r.actor_type === 'agent' && r.run_by).map((r) => r.run_by!))];
    const p = platformDb(this.db);
    const [users, agents] = await Promise.all([
      userIds.length ? p.selectFrom('users').select(['id', 'display_name']).where('id', 'in', userIds).execute() : [],
      agentIds.length ? p.selectFrom('agents').select(['id', 'name']).where('id', 'in', agentIds).execute() : [],
    ]);
    const names = new Map<string, string>([...users.map((u) => [u.id, u.display_name] as [string, string]), ...agents.map((a) => [a.id, agentLabel(a.name)] as [string, string])]);
    return rows.map((r) => ({
      id: r.id,
      runbook: r.runbook,
      input: r.input,
      subject: r.subject,
      status: r.status,
      summary: r.summary,
      findings: r.findings,
      dataAsOf: r.data_as_of,
      created_at: r.created_at,
      actor_type: r.actor_type,
      run_by: r.run_by,
      run_by_name: r.run_by ? names.get(r.run_by) ?? null : null,
    }));
  }

  /** The checks worth running for this incident, and with what. */
  async suggest(t: TenantContext, incidentId: string): Promise<DiagSuggestion[]> {
    const s = tenantDb(this.db, t.schema);
    const inc = await s.selectFrom('incidents').select(['id', 'category', 'description', 'details']).where('id', '=', incidentId).executeTakeFirst();
    if (!inc) throw new NotFoundException('incident not found');
    const items = await s.selectFrom('incident_items').select(['kind', 'ref', 'label']).where('incident_id', '=', incidentId).orderBy('created_at').execute();
    const details = (inc.details ?? {}) as Partial<IncDetails>;
    return diagSuggest({ category: inc.category, items, answers: details.answers as Record<string, unknown> | undefined, description: inc.description });
  }

  /** A check with no incident: used by the tests and by assistants that want to look before they claim. */
  async check(t: TenantContext, runbook: DiagRunInput['runbook'], input: string, siteId: string | null = null): Promise<DiagResult> {
    const s = tenantDb(this.db, t.schema);
    const def = DIAG_RUNBOOKS[runbook];
    if (def.input !== 'none' && !input) throw new BadRequestException(`Say which: ${def.inputLabel ?? 'what to check'}.`);
    const asOf = await this.dataAsOf(s);
    switch (runbook) {
      case 'user_voice':
        return this.userVoice(s, input, asOf);
      case 'number_check':
        return this.number(s, input, asOf);
      case 'queue_check':
        return this.queue(s, input, asOf);
      case 'routing_check':
        return this.routing(s, asOf);
      case 'emergency_check':
        return this.emergency(s, asOf);
      case 'recent_changes':
        return this.changes(s, asOf, siteId);
    }
  }

  /* ------------------------------ facts ------------------------------ */

  /** When the last full Discovery finished (any finished one if there has never been a full one). */
  private async dataAsOf(s: S): Promise<string | null> {
    const full = await s.selectFrom('tenant_discovery_runs').select((eb) => eb.fn.max('finished_at').as('at')).where('status', '=', 'completed').where('scope_types', 'is', null).executeTakeFirst();
    if (full?.at) return new Date(full.at as string).toISOString();
    const any = await s.selectFrom('tenant_discovery_runs').select((eb) => eb.fn.max('finished_at').as('at')).where('status', '=', 'completed').executeTakeFirst();
    return any?.at ? new Date(any.at as string).toISOString() : null;
  }

  private async userVoice(s: S, input: string, asOf: string | null): Promise<DiagResult> {
    const q = input.trim();
    let rows = await s.selectFrom('tenant_users').selectAll().where((eb) => eb(eb.fn('lower', ['upn']), '=', q.toLowerCase())).limit(2).execute();
    if (!rows.length && !q.includes('@')) {
      rows = await s.selectFrom('tenant_users').selectAll().where('removed_at', 'is', null).where('display_name', 'ilike', like(q)).orderBy('display_name').limit(6).execute();
    }
    if (rows.length > 1) return evalUserVoice(q, { found: false, ambiguous: rows.map((r) => r.upn) }, asOf);
    const u = rows[0];
    if (!u) return evalUserVoice(q, { found: false }, asOf);

    const [designRow, line] = await Promise.all([
      s
        .selectFrom('discovery_users as du')
        .leftJoin('discovery_sites as ds', 'ds.id', 'du.site_id')
        .leftJoin('discovery_calling_policies as cp', 'cp.id', 'du.calling_policy_id')
        .select(['cp.name as calling_policy', 'du.requested_number as requested_number', 'ds.sitecode as sitecode'])
        .where((eb) => eb(eb.fn('lower', ['du.upn']), '=', u.upn.toLowerCase()))
        .executeTakeFirst(),
      u.line_uri ? this.numberFacts(s, u.line_uri, u.upn) : Promise.resolve(null),
    ]);
    return evalUserVoice(
      q,
      {
        found: true,
        upn: u.upn,
        displayName: u.display_name,
        accountType: u.account_type,
        accountEnabled: u.account_enabled,
        enterpriseVoice: u.enterprise_voice_enabled,
        lineUri: u.line_uri,
        featureTypes: u.feature_types,
        assignedPlans: u.assigned_plans ?? undefined,
        usageLocation: u.usage_location,
        policies: u.policies ?? {},
        removedAt: u.removed_at,
        design: designRow ? { callingPolicy: designRow.calling_policy, requestedNumber: designRow.requested_number, siteCode: designRow.sitecode } : null,
        sameLineUsers: line?.lineUsers ?? [],
        numberRecord: line?.record ? { assignmentStatus: line.record.assignmentStatus, activationState: line.record.activationState } : null,
      },
      asOf,
    );
  }

  /** The tenant's record for a number, and who holds it. `except` leaves one person out (when asking about them). */
  private async numberFacts(s: S, number: string, except?: string) {
    const t = tail(number);
    const objects = t ? await s.selectFrom('tenant_objects').select(['display_name', 'object_key', 'data']).where('object_type', '=', 'phone_number').where('removed_at', 'is', null).where('object_key', 'like', `%${t}`).limit(5).execute() : [];
    const obj = objects.find((o) => diagSameNumber(o.object_key, number));
    const data = (obj?.data ?? {}) as Rec;
    const users = t ? await s.selectFrom('tenant_users').select(['upn', 'line_uri', 'display_name']).where('removed_at', 'is', null).where('line_uri', 'like', `%${t}%`).limit(10).execute() : [];
    const lineUsers = users.filter((u) => u.line_uri && diagSameNumber(u.line_uri, number) && u.upn.toLowerCase() !== except?.toLowerCase()).map((u) => u.upn);

    const ras = await s.selectFrom('tenant_objects').select(['display_name', 'object_key', 'data']).where('object_type', '=', 'resource_account').where('removed_at', 'is', null).execute();
    const targetId = str(data.AssignedPstnTargetId);
    const resourceAccounts = ras
      .filter((r) => {
        const d = r.data as Rec;
        const pn = str(d.PhoneNumber);
        return (pn && diagSameNumber(pn, number)) || (targetId && r.object_key.toLowerCase() === targetId.toLowerCase());
      })
      .map((r) => r.display_name ?? r.object_key);
    return {
      record: obj
        ? {
            number: obj.object_key,
            numberType: str(data.NumberType),
            assignmentStatus: str(data.AssignmentStatus) ?? str(data.PstnAssignmentStatus),
            activationState: str(data.ActivationState),
            assignedTo: targetId,
            city: str(data.City),
          }
        : null,
      lineUsers,
      resourceAccounts,
    };
  }

  private async number(s: S, input: string, asOf: string | null): Promise<DiagResult> {
    const norm = diagNormaliseNumber(input);
    const facts = await this.numberFacts(s, input);
    const t = tail(input);
    const inv = t
      ? await s
          .selectFrom('phone_numbers as pn')
          .leftJoin('discovery_number_ranges as r', 'r.id', 'pn.range_id')
          .select(['pn.e164 as e164', 'pn.status as status', 'pn.holder_type as holder_type', 'pn.holder_id as holder_id', 'r.range_start as range_start', 'r.range_end as range_end', 'r.carrier as carrier'])
          .where('pn.e164', 'like', `%${t}`)
          .limit(5)
          .execute()
      : [];
    const hit = inv.find((i) => diagSameNumber(i.e164, input));
    let holder: string | null = null;
    if (hit?.holder_id) {
      const id = hit.holder_id;
      if (hit.holder_type === 'user') holder = (await s.selectFrom('discovery_users').select('display_name').where('id', '=', id).executeTakeFirst())?.display_name ?? null;
      else if (hit.holder_type === 'cap') holder = (await s.selectFrom('discovery_caps').select('display_name').where('id', '=', id).executeTakeFirst())?.display_name ?? null;
      else if (hit.holder_type === 'resource_account') holder = (await s.selectFrom('discovery_resource_accounts').select('name').where('id', '=', id).executeTakeFirst())?.name ?? null;
    }
    const designRows = await s.selectFrom('discovery_users').select(['display_name', 'upn', 'requested_number']).where('requested_number', 'is not', null).execute();
    const designHolders = designRows.filter((d) => d.requested_number && diagSameNumber(d.requested_number, input)).map((d) => d.display_name ?? d.upn);
    return evalNumber(
      norm || input,
      {
        record: facts.record,
        lineUsers: facts.lineUsers,
        resourceAccounts: facts.resourceAccounts,
        inventory: hit ? { status: hit.status, holderType: hit.holder_type, holder, range: hit.range_start ? `${hit.range_start} - ${hit.range_end}${hit.carrier ? ` (${hit.carrier})` : ''}` : null } : null,
        designHolders,
      },
      asOf,
    );
  }

  private async queue(s: S, input: string, asOf: string | null): Promise<DiagResult> {
    const q = input.trim();
    const all = await s.selectFrom('tenant_objects').select(['object_type', 'object_key', 'display_name', 'data']).where('object_type', 'in', ['call_queue', 'auto_attendant']).where('removed_at', 'is', null).where('display_name', 'ilike', like(q)).limit(10).execute();
    const exact = all.filter((o) => (o.display_name ?? '').toLowerCase() === q.toLowerCase());
    const pick = exact.length === 1 ? exact[0] : all.length === 1 ? all[0] : undefined;
    if (!pick) return evalQueue(q, { found: false, ambiguous: all.length > 1 ? all.map((o) => o.display_name ?? o.object_key) : undefined }, asOf);
    const d = pick.data as Rec;
    const kind = pick.object_type as 'call_queue' | 'auto_attendant';

    // Everything the queue or attendant can point at, by id.
    const targetIds = new Set<string>();
    const agentIds = kind === 'call_queue' ? [...arr(d.Agents).map(idOf), ...((Array.isArray(d.Users) ? d.Users : []) as unknown[]).map(idOf)].filter((x): x is string => !!x) : [];
    agentIds.forEach((a) => targetIds.add(a));
    const targets: { label: string; type: string | null; id: string | null; detail?: string }[] = [];
    const addTarget = (label: string, t: unknown) => {
      const o = (t ?? {}) as Rec;
      const id = str(o.Id) ?? str(o.ObjectId);
      if (!id) return;
      targets.push({ label, type: str(o.Type), id });
      targetIds.add(id);
    };
    if (kind === 'call_queue') {
      addTarget('Overflow', d.OverflowActionTarget);
      addTarget('Time-out', d.TimeoutActionTarget);
      addTarget('No agents', d.NoAgentActionTarget);
    } else {
      const flow = (d.DefaultCallFlow ?? {}) as Rec;
      const menu = (flow.Menu ?? {}) as Rec;
      for (const opt of arr(menu.MenuOptions).slice(0, 12)) addTarget(`Menu option ${str(opt.DtmfResponse) ?? str(opt.VoiceResponses) ?? ''}`.trim(), opt.CallTarget);
      for (const flowOpt of arr(d.CallFlows).slice(0, 6)) for (const opt of arr(((flowOpt.Menu ?? {}) as Rec).MenuOptions).slice(0, 12)) addTarget(`${str(flowOpt.Name) ?? 'Other hours'} menu option ${str(opt.DtmfResponse) ?? ''}`.trim(), opt.CallTarget);
    }
    const raIds = ((Array.isArray(d.ApplicationInstances) ? d.ApplicationInstances : []) as unknown[]).map(idOf).filter((x): x is string => !!x);
    raIds.forEach((r) => targetIds.add(r));

    const ids = [...targetIds].map((x) => x.toLowerCase());
    const [users, objs] = await Promise.all([
      ids.length ? s.selectFrom('tenant_users').select(['entra_id', 'upn', 'display_name', 'account_enabled', 'enterprise_voice_enabled', 'removed_at']).where((eb) => eb(eb.fn('lower', ['entra_id']), 'in', ids)).execute() : [],
      ids.length ? s.selectFrom('tenant_objects').select(['object_type', 'object_key', 'display_name', 'data']).where('removed_at', 'is', null).where('object_type', 'in', ['resource_account', 'auto_attendant', 'call_queue']).where((eb) => eb(eb.fn('lower', ['object_key']), 'in', ids)).execute() : [],
    ]);
    const userBy = new Map(users.map((u) => [(u.entra_id ?? '').toLowerCase(), u]));
    const objBy = new Map(objs.map((o) => [o.object_key.toLowerCase(), o]));
    const dirUser = (id: string): DiagDirectoryUser | null => {
      const u = userBy.get(id.toLowerCase());
      return u ? { upn: u.upn, displayName: u.display_name, accountEnabled: u.account_enabled, enterpriseVoice: u.enterprise_voice_enabled, removed: !!u.removed_at } : null;
    };

    // A phone number held by a resource account: its own field, or a number record that points at it.
    const numbers = await s.selectFrom('tenant_objects').select(['object_key', 'data']).where('object_type', '=', 'phone_number').where('removed_at', 'is', null).execute();
    const numberOf = (id: string, own: unknown): string | null => {
      const direct = clean(str(own));
      if (direct) return direct;
      const rec = numbers.find((n) => str((n.data as Rec).AssignedPstnTargetId)?.toLowerCase() === id.toLowerCase());
      return rec ? rec.object_key : null;
    };

    const design = kind === 'call_queue' ? await this.queueDesign(s, pick.display_name ?? q, agentIds.map((a) => dirUser(a)?.upn).filter((x): x is string => !!x)) : null;
    return evalQueue(
      q,
      {
        found: true,
        kind,
        name: pick.display_name ?? q,
        agents: agentIds.map((id) => ({ id, user: dirUser(id) })),
        targets: targets.map((t) => {
          const type = t.type ?? '';
          const found = userBy.has(t.id!.toLowerCase()) ? 'user' : objBy.get(t.id!.toLowerCase())?.object_type;
          const checkable = /^(user|applicationendpoint|configurationendpoint|resourceaccount|callqueue|autoattendant)$/i.test(type) || !!found;
          const detail = userBy.get(t.id!.toLowerCase())?.display_name ?? objBy.get(t.id!.toLowerCase())?.display_name ?? undefined;
          return { label: t.label, kind: t.type, id: t.id, exists: checkable ? !!found : null, detail: detail ?? undefined };
        }),
        resourceAccounts: raIds.map((id) => {
          const o = objBy.get(id.toLowerCase());
          return { name: o?.display_name ?? id, number: o ? numberOf(id, (o.data as Rec).PhoneNumber) : null };
        }),
        design,
      },
      asOf,
    );
  }

  /** Agents the design (Design & Build) gives a queue of this name, against the agents the tenant has. */
  private async queueDesign(s: S, name: string, liveUpns: string[]) {
    const row = await s.selectFrom('build_call_queues').select(['agents']).where((eb) => eb(eb.fn('lower', ['name']), '=', name.toLowerCase())).executeTakeFirst();
    if (!row) return null;
    const designed = ((Array.isArray(row.agents) ? row.agents : []) as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
    const live = new Set(liveUpns.map((x) => x.toLowerCase()));
    return { missingFromTenant: designed.filter((x) => !live.has(x)), notInDesign: [...live].filter((x) => !designed.includes(x)) };
  }

  private async routing(s: S, asOf: string | null): Promise<DiagResult> {
    const objs = await s.selectFrom('tenant_objects').select(['object_type', 'display_name', 'object_key', 'data']).where('object_type', 'in', ['pstn_gateway', 'voice_route', 'pstn_usage']).where('removed_at', 'is', null).execute();
    const names = (v: unknown) => ((Array.isArray(v) ? v : v ? [v] : []) as unknown[]).map((x) => (typeof x === 'string' ? x : str((x as Rec)?.Fqdn) ?? str((x as Rec)?.Identity) ?? '')).filter(Boolean);
    return evalRouting(
      {
        gateways: objs.filter((o) => o.object_type === 'pstn_gateway').map((o) => ({ fqdn: str((o.data as Rec).Fqdn) ?? o.display_name ?? o.object_key, enabled: typeof (o.data as Rec).Enabled === 'boolean' ? ((o.data as Rec).Enabled as boolean) : null })),
        routes: objs
          .filter((o) => o.object_type === 'voice_route')
          .map((o) => {
            const d = o.data as Rec;
            return { name: o.display_name ?? o.object_key, gateways: names(d.OnlinePstnGatewayList), usages: names(d.OnlinePstnUsages), pattern: str(d.NumberPattern), priority: typeof d.Priority === 'number' ? d.Priority : null };
          }),
        usages: objs.filter((o) => o.object_type === 'pstn_usage').map((o) => o.display_name ?? o.object_key),
      },
      asOf,
    );
  }

  private async emergency(s: S, asOf: string | null): Promise<DiagResult> {
    const [objs, voiceUsers, policies] = await Promise.all([
      s.selectFrom('tenant_objects').select(['object_type', 'display_name', 'data']).where('object_type', 'in', ['emergency_location', 'civic_address']).where('removed_at', 'is', null).execute(),
      s.selectFrom('tenant_users').select(['policies']).where('removed_at', 'is', null).where('enterprise_voice_enabled', '=', true).execute(),
      s.selectFrom('tenant_policies').select(['name']).where('policy_type', '=', 'TeamsEmergencyCallingPolicy').where('removed_at', 'is', null).where('is_global', '=', false).execute(),
    ]);
    const locations = objs.filter((o) => o.object_type === 'emergency_location').map((o) => {
      const d = o.data as Rec;
      const v = str(d.ValidationStatus);
      return { name: o.display_name ?? 'Unnamed location', civicAddressId: str(d.CivicAddressId), validated: v ? /^validated$/i.test(v) : null };
    });
    return evalEmergency(
      {
        locations,
        civicAddresses: objs.filter((o) => o.object_type === 'civic_address').length,
        enterpriseVoiceUsers: voiceUsers.length,
        usersWithEmergencyPolicy: voiceUsers.filter((u) => !!(u.policies ?? {}).TeamsEmergencyCallingPolicy).length,
        emergencyPolicies: policies.map((p) => p.name),
        // Matching a site to a location by address is a guess; left out until locations are linked to sites.
        sitesWithoutLocation: [],
      },
      asOf,
    );
  }

  private async changes(s: S, asOf: string | null, _siteId: string | null): Promise<DiagResult> {
    const days = DIAG_RECENT_DAYS;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [versions, total, deps, srs] = await Promise.all([
      s.selectFrom('tenant_object_versions').select(['object_type', 'display_name', 'change_kind', 'changed_fields', 'changed_at']).where('changed_at', '>=', since).orderBy('changed_at', 'desc').limit(40).execute(),
      s.selectFrom('tenant_object_versions').select((eb) => eb.fn.countAll<number>().as('n')).where('changed_at', '>=', since).executeTakeFirst(),
      s
        .selectFrom('deployments as d')
        .select(['d.id as id', 'd.mode as mode', 'd.status as status', 'd.created_at as created_at'])
        .select((eb) => [
          eb.selectFrom('deployment_changes as c').select((e) => e.fn.countAll<number>().as('n')).whereRef('c.deployment_id', '=', 'd.id').where('c.result', '=', 'failed').as('failed'),
          eb.selectFrom('deployment_changes as c').select((e) => e.fn.countAll<number>().as('n')).whereRef('c.deployment_id', '=', 'd.id').where('c.result', '=', 'applied').as('applied'),
        ])
        .where('d.created_at', '>=', since)
        .orderBy('d.created_at', 'desc')
        .limit(20)
        .execute(),
      s.selectFrom('service_requests').select(['number', 'title', 'status', 'updated_at']).where('updated_at', '>=', since).where('status', 'in', ['deployed', 'planned', 'built']).orderBy('updated_at', 'desc').limit(10).execute(),
    ]);
    return evalChanges(
      {
        days,
        tenantChanges: versions.map((v) => ({ type: v.object_type, name: v.display_name, kind: v.change_kind, at: new Date(v.changed_at).toISOString(), fields: v.changed_fields })),
        tenantChangeTotal: Number(total?.n ?? 0),
        deployments: deps.map((d) => ({ id: d.id, mode: d.mode, status: d.status, at: new Date(d.created_at).toISOString(), failedChanges: Number(d.failed ?? 0), appliedChanges: Number(d.applied ?? 0) })).filter((d) => d.mode === 'execute'),
        serviceRequests: srs.map((r) => ({ reference: srReference(r.number), title: r.title, status: r.status, at: new Date(r.updated_at).toISOString() })),
      },
      asOf,
    );
  }
}
