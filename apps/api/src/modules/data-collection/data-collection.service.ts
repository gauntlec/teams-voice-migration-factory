import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import type {
  DiscoveryFlowInput,
  DiscoveryGeneralInput,
  DiscoveryNetworkInput,
  DiscoverySiteInput,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { assertCustomerWide, assertSiteInScope } from './site-scope';

type Actor = Pick<AuthedUser, 'id' | 'email'>;
const actorOf = (u: AuthedUser): Actor => ({ id: u.id, email: u.email });

@Injectable()
export class DataCollectionService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private scoped(t: TenantContext) {
    return tenantDb(this.db, t.schema);
  }

  private async discoveryRow(t: TenantContext) {
    const row = await this.scoped(t).selectFrom('discovery').selectAll().executeTakeFirst();
    if (!row) {
      // Should exist (seeded in tenant migration 0001); create defensively.
      return this.scoped(t)
        .insertInto('discovery')
        .values({ status: 'draft', general: {} })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return row;
  }

  /** Guards every mutation: draft is open, submitted needs review rights, accepted is locked. */
  async assertEditable(t: TenantContext, canReview: boolean) {
    const { status } = await this.discoveryRow(t);
    if (status === 'accepted') {
      throw new ConflictException('Discovery is accepted and locked. Reopen it to make changes.');
    }
    if (status === 'submitted' && !canReview) {
      throw new ForbiddenException(
        'Discovery has been submitted for review. Ask an engineer to reopen it.',
      );
    }
  }

  async get(t: TenantContext) {
    const s = this.scoped(t);
    const scope = t.siteScope;
    let sitesQ = s.selectFrom('discovery_sites').selectAll().orderBy('sitecode');
    let networkQ = s.selectFrom('discovery_network').selectAll().orderBy('scope').orderBy('subnet');
    let flowsQ = s.selectFrom('discovery_flows').selectAll().orderBy('kind').orderBy('name');
    if (scope) {
      // A site contact only ever sees their own sites and the rows tied to them.
      sitesQ = sitesQ.where('id', 'in', scope);
      networkQ = networkQ.where('site_id', 'in', scope);
      flowsQ = flowsQ.where('site_id', 'in', scope);
    }
    const [discovery, sites, network, flows] = await Promise.all([
      this.discoveryRow(t),
      sitesQ.execute(),
      networkQ.execute(),
      flowsQ.execute(),
    ]);
    return { discovery, sites, network, flows };
  }

  async updateGeneral(t: TenantContext, user: AuthedUser, patch: DiscoveryGeneralInput, canReview: boolean) {
    assertCustomerWide(t, 'The discovery overview');
    await this.assertEditable(t, canReview);
    const current = await this.discoveryRow(t);
    const next = { ...(current.general ?? {}), ...patch };
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({ general: next, updated_at: new Date().toISOString() })
      .returning(['id', 'general', 'status'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.general_updated', {
      actor: actorOf(user),
      detail: { fields: Object.keys(patch) },
    });
    return row;
  }

  async submit(t: TenantContext, user: AuthedUser) {
    assertCustomerWide(t, 'Submitting the discovery for review');
    const current = await this.discoveryRow(t);
    if (current.status !== 'draft') {
      throw new ConflictException(`Cannot submit discovery from status "${current.status}".`);
    }
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({
        status: 'submitted',
        submitted_by: user.id,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .returning(['id', 'status', 'submitted_at'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.submitted', { actor: actorOf(user) });
    await this.audit.platform('discovery.submitted', { actor: actorOf(user), tenantId: t.id });
    return row;
  }

  async accept(t: TenantContext, user: AuthedUser) {
    const current = await this.discoveryRow(t);
    if (current.status !== 'submitted') {
      throw new ConflictException(`Cannot accept discovery from status "${current.status}".`);
    }
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({
        status: 'accepted',
        accepted_by: user.id,
        accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .returning(['id', 'status', 'accepted_at'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.accepted', { actor: actorOf(user) });
    await this.audit.platform('discovery.accepted', { actor: actorOf(user), tenantId: t.id });
    return row;
  }

  async reopen(t: TenantContext, user: AuthedUser) {
    const current = await this.discoveryRow(t);
    if (current.status === 'draft') return { id: current.id, status: 'draft' as const };
    const row = await this.scoped(t)
      .updateTable('discovery')
      .set({
        status: 'draft',
        submitted_by: null,
        submitted_at: null,
        accepted_by: null,
        accepted_at: null,
        updated_at: new Date().toISOString(),
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.reopened', { actor: actorOf(user) });
    return row;
  }

  /* -------------------------------- sites -------------------------------- */

  async addSite(t: TenantContext, user: AuthedUser, input: DiscoverySiteInput, canReview: boolean) {
    assertCustomerWide(t, 'Sites');
    await this.assertEditable(t, canReview);
    let row;
    try {
      row = await this.scoped(t)
        .insertInto('discovery_sites')
        .values({
          sitecode: input.sitecode,
          name: input.name || null,
          address: input.address || null,
          country: input.country || null,
          region: input.region || null,
          paging: input.paging ?? {},
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (/duplicate key|unique/i.test((e as Error).message)) {
        throw new ConflictException(`A site with code "${input.sitecode}" already exists.`);
      }
      throw e;
    }
    await this.audit.tenant(t.schema, 'discovery.site_added', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: row.id,
    });
    return row;
  }

  async updateSite(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoverySiteInput>,
    canReview: boolean,
  ) {
    assertCustomerWide(t, 'Sites');
    await this.assertEditable(t, canReview);
    const set = cleanPatch(patch);
    if ('sitecode' in set && set.sitecode == null) {
      throw new ConflictException('A site must have a site code.');
    }
    let row;
    try {
      row = await this.scoped(t)
        .updateTable('discovery_sites')
        .set(set)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
    } catch (e) {
      if (/duplicate key|unique/i.test((e as Error).message)) {
        throw new ConflictException(`A site with code "${patch.sitecode}" already exists.`);
      }
      throw e;
    }
    if (!row) throw new NotFoundException('site not found');
    await this.audit.tenant(t.schema, 'discovery.site_updated', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: id,
    });
    return row;
  }

  async deleteSite(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    assertCustomerWide(t, 'Sites');
    await this.assertEditable(t, canReview);
    const res = await this.scoped(t).deleteFrom('discovery_sites').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('site not found');
    await this.audit.tenant(t.schema, 'discovery.site_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: id,
    });
    return { ok: true };
  }

  /* Number ranges, inventory, calling policies, users, CAPs and resource
   * accounts now live in TelephonyService (data-collection.telephony.service). */

  /**
   * For the site-linked discovery tables (network / flows): a site contact may
   * only touch a row whose `site_id` is one of theirs. No-op for whole-customer
   * callers.
   */
  private async assertRowSiteInScope(
    t: TenantContext,
    table: 'discovery_network' | 'discovery_flows',
    id: string,
    notFound: string,
  ) {
    if (!t.siteScope) return;
    const row = await this.scoped(t)
      .selectFrom(table)
      .select('site_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(notFound);
    assertSiteInScope(t, row.site_id);
  }

  /* ------------------------------- network ----------------------------- */

  async addNetwork(
    t: TenantContext,
    user: AuthedUser,
    input: DiscoveryNetworkInput,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    assertSiteInScope(t, input.site_id ?? null);
    const row = await this.scoped(t)
      .insertInto('discovery_network')
      .values({
        site_id: input.site_id ?? null,
        scope: input.scope,
        subnet: input.subnet,
        mask: input.mask ?? null,
        location: input.location || null,
        network_type: input.network_type ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.network_added', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: row.id,
    });
    return row;
  }

  async updateNetwork(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoveryNetworkInput>,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_network', id, 'subnet not found');
    if ('site_id' in patch) assertSiteInScope(t, patch.site_id ?? null);
    const row = await this.scoped(t)
      .updateTable('discovery_network')
      .set(cleanPatch(patch))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('subnet not found');
    await this.audit.tenant(t.schema, 'discovery.network_updated', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: id,
    });
    return row;
  }

  async deleteNetwork(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_network', id, 'subnet not found');
    const res = await this.scoped(t).deleteFrom('discovery_network').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('subnet not found');
    await this.audit.tenant(t.schema, 'discovery.network_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_network',
      targetId: id,
    });
    return { ok: true };
  }

  /* -------------------------------- flows ------------------------------- */

  async addFlow(t: TenantContext, user: AuthedUser, input: DiscoveryFlowInput, canReview: boolean) {
    await this.assertEditable(t, canReview);
    assertSiteInScope(t, input.site_id ?? null);
    const row = await this.scoped(t)
      .insertInto('discovery_flows')
      .values({
        site_id: input.site_id ?? null,
        kind: input.kind,
        name: input.name,
        description: input.description || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.tenant(t.schema, 'discovery.flow_added', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: row.id,
    });
    return row;
  }

  async updateFlow(
    t: TenantContext,
    user: AuthedUser,
    id: string,
    patch: Partial<DiscoveryFlowInput>,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_flows', id, 'flow not found');
    if ('site_id' in patch) assertSiteInScope(t, patch.site_id ?? null);
    const row = await this.scoped(t)
      .updateTable('discovery_flows')
      .set({ ...cleanPatch(patch), updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('flow not found');
    await this.audit.tenant(t.schema, 'discovery.flow_updated', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: id,
    });
    return row;
  }

  async deleteFlow(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
    await this.assertEditable(t, canReview);
    await this.assertRowSiteInScope(t, 'discovery_flows', id, 'flow not found');
    const res = await this.scoped(t).deleteFrom('discovery_flows').where('id', '=', id).executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('flow not found');
    await this.audit.tenant(t.schema, 'discovery.flow_deleted', {
      actor: actorOf(user),
      targetType: 'discovery_flow',
      targetId: id,
    });
    return { ok: true };
  }
}

/** Drop undefined keys and normalise '' to null for a partial update. */
function cleanPatch<T extends Record<string, unknown>>(patch: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v === '' ? null : v;
  }
  return out;
}
