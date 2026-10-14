import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  INC_OPEN_STATUSES,
  INC_PROBLEM_STATUS_LABELS,
  incIsKnownError,
  incProblemMatches,
  incProblemReference,
  incReference,
  type CreateProblemInput,
  type KnownErrorsQuery,
  type LinkProblemInput,
  type UpdateProblemInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';
import { IncidentNotifier } from './incident-notifier';

/**
 * Problem records: the cause behind one or more incidents - root cause, workaround, and
 * whether it is a known error engineers (and agents) can use on new incidents of the
 * same kind. Engineers and admins only, except `knownErrors`, which gives customers just
 * the note written for them. See docs/INCIDENT-MANAGEMENT.md.
 */
@Injectable()
export class ProblemsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: IncidentNotifier,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private async owners(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await platformDb(this.db).selectFrom('users').select(['id', 'display_name']).where('id', 'in', unique).execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  private async requireOwner(t: TenantContext, ownerId: string | null | undefined) {
    if (!ownerId) return;
    if (!(await this.notify.staff(t)).some((m) => m.id === ownerId)) throw new BadRequestException('The owner must be an engineer on this customer, or a Super Admin.');
  }

  async list(t: TenantContext, status?: string) {
    this.assertEnabled(t);
    let q = tenantDb(this.db, t.schema)
      .selectFrom('problems as p')
      .select((eb) => [
        'p.id as id', 'p.number as number', 'p.title as title', 'p.status as status', 'p.category as category', 'p.subcategory as subcategory', 'p.owner_id as owner_id',
        'p.created_at as created_at', 'p.updated_at as updated_at', 'p.resolved_at as resolved_at', 'p.workaround as workaround',
        eb.selectFrom('incidents as i').select((e) => e.fn.countAll<string>().as('n')).whereRef('i.problem_id', '=', 'p.id').as('incident_count'),
        eb
          .selectFrom('incidents as i')
          .select((e) => e.fn.countAll<string>().as('n'))
          .whereRef('i.problem_id', '=', 'p.id')
          .where('i.status', 'in', [...INC_OPEN_STATUSES])
          .as('open_incidents'),
      ])
      .orderBy('p.number', 'desc');
    if (status === 'open') q = q.where('p.status', '!=', 'resolved');
    else if (status && status !== 'all') q = q.where('p.status', '=', status as never);
    const rows = await q.execute();
    const names = await this.owners(rows.map((r) => r.owner_id));
    return rows.map(({ workaround, ...r }) => ({ ...r, incident_count: Number(r.incident_count ?? 0), open_incidents: Number(r.open_incidents ?? 0), reference: incProblemReference(r.number), owner_name: r.owner_id ? (names.get(r.owner_id) ?? null) : null, known_error: incIsKnownError({ status: r.status, workaround }) }));
  }

  async get(t: TenantContext, id: string) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    const p = await s.selectFrom('problems').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException('problem not found');
    const incidents = await s
      .selectFrom('incidents as i')
      .leftJoin('discovery_sites as ds', 'ds.id', 'i.site_id')
      .select(['i.id as id', 'i.number as number', 'i.title as title', 'i.status as status', 'i.priority as priority', 'ds.sitecode as sitecode', 'i.created_at as created_at'])
      .where('i.problem_id', '=', id)
      .orderBy('i.number', 'desc')
      .execute();
    const names = await this.owners([p.owner_id]);
    return {
      ...p,
      reference: incProblemReference(p.number),
      owner_name: p.owner_id ? (names.get(p.owner_id) ?? null) : null,
      known_error: incIsKnownError(p),
      status_label: INC_PROBLEM_STATUS_LABELS[p.status],
      incidents: incidents.map((i) => ({ ...i, reference: incReference(i.number) })),
    };
  }

  async create(t: TenantContext, user: AuthedUser, input: CreateProblemInput) {
    this.assertEnabled(t);
    await this.requireOwner(t, input.ownerId);
    if (input.subcategory && !input.category) throw new BadRequestException('Choose a category for that sub-category.');
    const s = tenantDb(this.db, t.schema);
    const now = new Date().toISOString();
    const row = await s
      .insertInto('problems')
      .values({
        title: input.title,
        description: input.description,
        category: input.category,
        subcategory: input.subcategory,
        status: input.status,
        root_cause: input.rootCause,
        workaround: input.workaround,
        customer_note: input.customerNote,
        owner_id: input.ownerId,
        created_by: user.id,
        resolved_at: input.status === 'resolved' ? now : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'problem.created', {
      actor: { id: user.id, email: user.email },
      targetType: 'problem',
      targetId: row.id,
      detail: { reference: incProblemReference(row.number), title: row.title },
    });
    if (input.incidentId) await this.link(t, user, input.incidentId, { problemId: row.id });
    return { ...row, reference: incProblemReference(row.number) };
  }

  async update(t: TenantContext, user: AuthedUser, id: string, input: UpdateProblemInput) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    const current = await s.selectFrom('problems').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw new NotFoundException('problem not found');
    await this.requireOwner(t, input.ownerId);
    const category = input.category === undefined ? current.category : input.category;
    const subcategory = input.subcategory === undefined ? current.subcategory : input.subcategory;
    if (subcategory && !category) throw new BadRequestException('Choose a category for that sub-category.');
    const now = new Date().toISOString();
    const status = input.status ?? current.status;
    const row = await s
      .updateTable('problems')
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        category,
        // A new category makes the old sub-category meaningless.
        subcategory: input.category !== undefined && input.category !== current.category && input.subcategory === undefined ? null : subcategory,
        status,
        ...(input.rootCause !== undefined ? { root_cause: input.rootCause } : {}),
        ...(input.workaround !== undefined ? { workaround: input.workaround } : {}),
        ...(input.customerNote !== undefined ? { customer_note: input.customerNote } : {}),
        ...(input.ownerId !== undefined ? { owner_id: input.ownerId } : {}),
        resolved_at: status === 'resolved' ? (current.resolved_at ?? now) : null,
        updated_at: now,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'problem.updated', {
      actor: { id: user.id, email: user.email },
      targetType: 'problem',
      targetId: id,
      detail: { reference: incProblemReference(row.number), changed: Object.keys(input) },
    });
    return { ...row, reference: incProblemReference(row.number) };
  }

  /** Link an incident to the problem behind it (null unlinks). */
  async link(t: TenantContext, user: AuthedUser, incidentId: string, input: LinkProblemInput) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    const inc = await s.selectFrom('incidents').select(['id', 'number', 'site_id', 'problem_id']).where('id', '=', incidentId).executeTakeFirst();
    if (!inc) throw new NotFoundException('incident not found');
    if (isSiteScoped(t)) assertSiteInScope(t, inc.site_id);
    let problem: { number: number; title: string } | undefined;
    if (input.problemId) {
      problem = await s.selectFrom('problems').select(['number', 'title']).where('id', '=', input.problemId).executeTakeFirst();
      if (!problem) throw new BadRequestException('That problem does not exist for this customer.');
    }
    if (inc.problem_id === input.problemId) return { ok: true };
    await s.updateTable('incidents').set({ problem_id: input.problemId, updated_at: new Date().toISOString(), version: sql`version + 1` }).where('id', '=', incidentId).execute();
    await s
      .insertInto('incident_events')
      .values({
        incident_id: incidentId,
        kind: 'problem_linked',
        body: problem ? `Linked to ${incProblemReference(problem.number)}: ${problem.title}` : 'Unlinked from its problem',
        internal: true,
        author_id: user.id,
        meta: JSON.stringify({ problemId: input.problemId }),
      })
      .execute();
    await this.audit.tenant(t.schema, 'incident.problem_linked', {
      actor: { id: user.id, email: user.email },
      targetType: 'incident',
      targetId: incidentId,
      detail: { reference: incReference(inc.number), problem: problem ? incProblemReference(problem.number) : null },
    });
    return { ok: true };
  }

  /**
   * Known errors for an incident of this kind. Engineers get the workaround; a
   * customer gets only the title and the note written for them (and only when there is one).
   */
  async knownErrors(t: TenantContext, q: KnownErrorsQuery, canManage: boolean) {
    this.assertEnabled(t);
    const rows = await tenantDb(this.db, t.schema)
      .selectFrom('problems')
      .select(['id', 'number', 'title', 'status', 'category', 'subcategory', 'workaround', 'customer_note', 'root_cause'])
      .where('status', 'in', ['known_error', 'fix_planned'])
      .where('category', '=', q.category)
      .orderBy('number', 'desc')
      .execute();
    return rows
      .filter((p) => incIsKnownError(p) && incProblemMatches(p, q.category, q.subcategory ?? null))
      .filter((p) => canManage || p.customer_note.trim())
      .map((p) =>
        canManage
          ? { id: p.id, reference: incProblemReference(p.number), title: p.title, status: p.status, workaround: p.workaround, root_cause: p.root_cause, customer_note: p.customer_note }
          : { id: p.id, reference: incProblemReference(p.number), title: p.title, customer_note: p.customer_note },
      );
  }
}
