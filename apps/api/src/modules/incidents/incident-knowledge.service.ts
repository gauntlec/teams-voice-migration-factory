import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import { incReference, knowledgeMatches, type KnowledgeCreateInput, type KnowledgeSnippet, type KnowledgeUpdateInput } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

/**
 * Knowledge from resolved incidents (docs/INTAKE.md): saved by an engineer from an incident that was fixed, matched to new incidents
 * (engineers and assistants see the fix; customers see only a tip written for them, and only if there is one), and sharpened by
 * "this helped" feedback.
 */
@Injectable()
export class IncidentKnowledgeService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private assertEnabled(t: TenantContext) {
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
  }

  private async active(t: TenantContext) {
    return tenantDb(this.db, t.schema).selectFrom('incident_knowledge').selectAll().where('archived', '=', false).execute();
  }

  async list(t: TenantContext) {
    this.assertEnabled(t);
    return tenantDb(this.db, t.schema).selectFrom('incident_knowledge').selectAll().where('archived', '=', false).orderBy('updated_at', 'desc').execute();
  }

  /** What to start from when saving knowledge off an incident: its title, what was reported, and how it was fixed. */
  async draftFrom(t: TenantContext, incidentId: string) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    const inc = await s.selectFrom('incidents').select(['id', 'number', 'title', 'description', 'category', 'subcategory', 'status']).where('id', '=', incidentId).executeTakeFirst();
    if (!inc) throw new NotFoundException('incident not found');
    const fix = await s
      .selectFrom('incident_events')
      .select(['body'])
      .where('incident_id', '=', incidentId)
      .where('kind', '=', 'status_changed')
      .where('to_status', 'in', ['resolved', 'restored'])
      .where('internal', '=', false)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return { title: inc.title, category: inc.category, subcategory: inc.subcategory, symptoms: inc.description, fix: fix?.body ?? '', customerText: '', sourceIncidentId: inc.id, reference: incReference(inc.number) };
  }

  async create(t: TenantContext, user: AuthedUser, input: KnowledgeCreateInput) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    if (input.sourceIncidentId) {
      const src = await s.selectFrom('incidents').select('id').where('id', '=', input.sourceIncidentId).executeTakeFirst();
      if (!src) throw new BadRequestException('That incident does not exist.');
    }
    const row = await s
      .insertInto('incident_knowledge')
      .values({ title: input.title, category: input.category, subcategory: input.subcategory ?? null, symptoms: input.symptoms, fix: input.fix, customer_text: input.customerText, source_incident_id: input.sourceIncidentId ?? null, created_by: user.agent ? null : user.id })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'incident.knowledge_saved', { actor: { id: user.id, email: user.email }, targetType: 'incident_knowledge', targetId: row.id, detail: { title: row.title, category: row.category } });
    return row;
  }

  async update(t: TenantContext, user: AuthedUser, id: string, input: KnowledgeUpdateInput) {
    this.assertEnabled(t);
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.title !== undefined) set.title = input.title;
    if (input.category !== undefined) set.category = input.category;
    if (input.subcategory !== undefined) set.subcategory = input.subcategory;
    if (input.symptoms !== undefined) set.symptoms = input.symptoms;
    if (input.fix !== undefined) set.fix = input.fix;
    if (input.customerText !== undefined) set.customer_text = input.customerText;
    const row = await tenantDb(this.db, t.schema).updateTable('incident_knowledge').set(set).where('id', '=', id).where('archived', '=', false).returningAll().executeTakeFirst();
    if (!row) throw new NotFoundException('knowledge not found');
    await this.audit.tenant(t.schema, 'incident.knowledge_updated', { actor: { id: user.id, email: user.email }, targetType: 'incident_knowledge', targetId: id, detail: { fields: Object.keys(set) } });
    return row;
  }

  async archive(t: TenantContext, user: AuthedUser, id: string) {
    this.assertEnabled(t);
    const row = await tenantDb(this.db, t.schema).updateTable('incident_knowledge').set({ archived: true, updated_at: new Date().toISOString() }).where('id', '=', id).returning('id').executeTakeFirst();
    if (!row) throw new NotFoundException('knowledge not found');
    await this.audit.tenant(t.schema, 'incident.knowledge_archived', { actor: { id: user.id, email: user.email }, targetType: 'incident_knowledge', targetId: id, detail: {} });
    return { archived: true };
  }

  async feedback(t: TenantContext, id: string, helpful: boolean) {
    this.assertEnabled(t);
    const s = tenantDb(this.db, t.schema);
    const row = await s
      .updateTable('incident_knowledge')
      .set((eb) => (helpful ? { helpful: eb('helpful', '+', 1) } : { not_helpful: eb('not_helpful', '+', 1) }))
      .where('id', '=', id)
      .returning(['id', 'helpful', 'not_helpful'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('knowledge not found');
    return row;
  }

  /** What matches an incident (or a form being filled in). `staff` sees the fix; a customer only the tip written for them. */
  async match(t: TenantContext, q: { category: string; subcategory?: string | null; text?: string }, staff: boolean, limit = 3) {
    this.assertEnabled(t);
    const all = (await this.active(t)).filter((k) => staff || k.customer_text.trim());
    const picked = knowledgeMatches(all as unknown as (KnowledgeSnippet & (typeof all)[number])[], q, limit);
    return picked.map((k) => (staff ? { id: k.id, title: k.title, category: k.category, subcategory: k.subcategory, symptoms: k.symptoms, fix: k.fix, customer_text: k.customer_text, helpful: k.helpful, not_helpful: k.not_helpful } : { id: k.id, title: k.title, customer_text: k.customer_text }));
  }

  async matchIncident(t: TenantContext, incidentId: string, limit = 3) {
    const inc = await tenantDb(this.db, t.schema).selectFrom('incidents').select(['category', 'subcategory', 'title', 'description']).where('id', '=', incidentId).executeTakeFirst();
    if (!inc) throw new NotFoundException('incident not found');
    return this.match(t, { category: inc.category, subcategory: inc.subcategory, text: `${inc.title} ${inc.description}` }, true, limit);
  }
}
