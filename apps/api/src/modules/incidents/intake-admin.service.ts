import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import { formatIntakeToken, intakeTokenHint, type IntakeSourceCreateInput, type IntakeSourceUpdateInput } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

/** Monitoring alert sources for one customer: who may post alerts, with what defaults. Super Admins only; the token is shown once. */
@Injectable()
export class IntakeAdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async source(t: TenantContext, id: string) {
    const r = await platformDb(this.db).selectFrom('intake_sources').selectAll().where('id', '=', id).where('tenant_id', '=', t.id).executeTakeFirst();
    if (!r) throw new NotFoundException('alert source not found');
    return r;
  }

  private view(r: Awaited<ReturnType<IntakeAdminService['source']>>) {
    const { secret_hash: _h, ...rest } = r;
    return { ...rest, hint: intakeTokenHint(r.last4) };
  }

  async list(t: TenantContext) {
    const rows = await platformDb(this.db).selectFrom('intake_sources').selectAll().where('tenant_id', '=', t.id).orderBy('name').execute();
    return rows.map((r) => this.view(r));
  }

  async create(t: TenantContext, user: AuthedUser, input: IntakeSourceCreateInput) {
    if (!t.managedServices) throw new BadRequestException('Managed Services is not switched on for this customer.');
    const secret = randomBytes(32).toString('base64url');
    try {
      const row = await platformDb(this.db)
        .insertInto('intake_sources')
        .values({ tenant_id: t.id, name: input.name, kind: input.kind, config: JSON.stringify(input.config), secret_hash: sha256(secret), last4: secret.slice(-4), ip_allow: input.ipAllow, created_by: user.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.tenant(t.schema, 'intake.source_created', { actor: { id: user.id, email: user.email }, targetType: 'intake_source', targetId: row.id, detail: { name: row.name, kind: row.kind } });
      return { ...this.view(row), token: formatIntakeToken(row.id, secret) };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('A source with that name already exists for this customer.');
      throw e;
    }
  }

  async update(t: TenantContext, user: AuthedUser, id: string, input: IntakeSourceUpdateInput) {
    await this.source(t, id);
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.config !== undefined) set.config = JSON.stringify(input.config);
    if (input.ipAllow !== undefined) set.ip_allow = input.ipAllow;
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (Object.keys(set).length) {
      try {
        await platformDb(this.db).updateTable('intake_sources').set(set).where('id', '=', id).execute();
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('A source with that name already exists for this customer.');
        throw e;
      }
    }
    await this.audit.tenant(t.schema, 'intake.source_updated', { actor: { id: user.id, email: user.email }, targetType: 'intake_source', targetId: id, detail: { fields: Object.keys(set) } });
    return this.view(await this.source(t, id));
  }

  /** A new token; the old one stops working at once. */
  async rotate(t: TenantContext, user: AuthedUser, id: string) {
    await this.source(t, id);
    const secret = randomBytes(32).toString('base64url');
    await platformDb(this.db).updateTable('intake_sources').set({ secret_hash: sha256(secret), last4: secret.slice(-4) }).where('id', '=', id).execute();
    await this.audit.tenant(t.schema, 'intake.source_token_rotated', { actor: { id: user.id, email: user.email }, targetType: 'intake_source', targetId: id, detail: {} });
    return { ...this.view(await this.source(t, id)), token: formatIntakeToken(id, secret) };
  }

  async remove(t: TenantContext, user: AuthedUser, id: string) {
    const r = await this.source(t, id);
    await platformDb(this.db).deleteFrom('intake_sources').where('id', '=', id).execute();
    await this.audit.tenant(t.schema, 'intake.source_deleted', { actor: { id: user.id, email: user.email }, targetType: 'intake_source', targetId: id, detail: { name: r.name } });
    return { deleted: true };
  }
}
