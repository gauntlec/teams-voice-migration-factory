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
    const [discovery, sites, network, flows] = await Promise.all([
      this.discoveryRow(t),
      s.selectFrom('discovery_sites').selectAll().orderBy('name').orderBy('site_code').execute(),
      s.selectFrom('discovery_network').selectAll().orderBy('scope').orderBy('subnet').execute(),
      s.selectFrom('discovery_flows').selectAll().orderBy('kind').orderBy('name').execute(),
    ]);
    return { discovery, sites, network, flows };
  }

  async updateGeneral(t: TenantContext, user: AuthedUser, patch: DiscoveryGeneralInput, canReview: boolean) {
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
    await this.assertEditable(t, canReview);
    const row = await this.scoped(t)
      .insertInto('discovery_sites')
      .values({
        site_code: input.site_code || null,
        name: input.name || null,
        address: input.address || null,
        country: input.country || null,
        region: input.region || null,
        paging: input.paging ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
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
    await this.assertEditable(t, canReview);
    const row = await this.scoped(t)
      .updateTable('discovery_sites')
      .set(cleanPatch(patch))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('site not found');
    await this.audit.tenant(t.schema, 'discovery.site_updated', {
      actor: actorOf(user),
      targetType: 'discovery_site',
      targetId: id,
    });
    return row;
  }

  async deleteSite(t: TenantContext, user: AuthedUser, id: string, canReview: boolean) {
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

  /* ------------------------------- network ----------------------------- */

  async addNetwork(
    t: TenantContext,
    user: AuthedUser,
    input: DiscoveryNetworkInput,
    canReview: boolean,
  ) {
    await this.assertEditable(t, canReview);
    const row = await this.scoped(t)
      .insertInto('discovery_network')
      .values({
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
    const row = await this.scoped(t)
      .insertInto('discovery_flows')
      .values({
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
