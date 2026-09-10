import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import type { CreateDeploymentInput } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { InjectDeployQueue, type Queue } from '../../queue/queue.module';

@Injectable()
export class DeploymentService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectDeployQueue() private readonly queue: Queue,
    private readonly audit: AuditService,
  ) {}

  async startConnection(t: TenantContext, user: AuthedUser, tenantDomain?: string) {
    const conn = await tenantDb(this.db, t.schema)
      .insertInto('connections')
      .values({
        started_by: user.id,
        method: 'device_code',
        status: 'pending',
        tenant_domain: tenantDomain ?? null,
        scopes: process.env.MS_GRAPH_SCOPES ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.queue.add('connection.start', {
      kind: 'connection.start',
      tenantId: t.id,
      schema: t.schema,
      connectionId: conn.id,
      operatorUserId: user.id,
      tenantDomain: tenantDomain ?? null,
    });

    await this.audit.tenant(t.schema, 'deployment.connection_started', {
      actor: { id: user.id, email: user.email },
      targetType: 'connection',
      targetId: conn.id,
      detail: { tenantDomain },
    });
    await this.audit.platform('deployment.connection_started', {
      actor: { id: user.id, email: user.email },
      tenantId: t.id,
      targetType: 'connection',
      targetId: conn.id,
    });
    return conn;
  }

  listConnections(t: TenantContext) {
    return tenantDb(this.db, t.schema)
      .selectFrom('connections')
      .selectAll()
      .orderBy('started_at', 'desc')
      .limit(50)
      .execute();
  }

  async getConnection(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema)
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('connection not found');
    return row;
  }

  async createDeployment(
    t: TenantContext,
    user: AuthedUser,
    input: CreateDeploymentInput,
    can: (p: 'deployment:execute') => boolean,
  ) {
    if (input.mode === 'execute' && !can('deployment:execute')) {
      throw new ForbiddenException('Missing permission: deployment:execute');
    }
    const conn = await this.getConnection(t, input.connectionId);
    if (conn.started_by !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'This customer-tenant session belongs to another engineer. Start your own connection, or ask a Super Admin.',
      );
    }
    if (conn.status !== 'active') {
      throw new ForbiddenException('Connection is not active - sign in to the customer tenant first');
    }

    const dep = await tenantDb(this.db, t.schema)
      .insertInto('deployments')
      .values({
        connection_id: conn.id,
        mode: input.mode,
        scope: input.scope,
        status: 'queued',
        created_by: user.id,
        summary: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.queue.add('deployment.run', {
      kind: 'deployment.run',
      tenantId: t.id,
      schema: t.schema,
      connectionId: conn.id,
      deploymentId: dep.id,
      mode: input.mode,
      scope: input.scope,
      operatorUserId: user.id,
    });

    await this.audit.tenant(t.schema, 'deployment.queued', {
      actor: { id: user.id, email: user.email },
      targetType: 'deployment',
      targetId: dep.id,
      detail: { mode: input.mode, scope: input.scope },
    });
    await this.audit.platform('deployment.queued', {
      actor: { id: user.id, email: user.email },
      tenantId: t.id,
      targetType: 'deployment',
      targetId: dep.id,
      detail: { mode: input.mode },
    });
    return dep;
  }

  listDeployments(t: TenantContext) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployments')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
  }

  async getDeployment(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema)
      .selectFrom('deployments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('deployment not found');
    return row;
  }

  changes(t: TenantContext, id: string) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployment_changes')
      .selectAll()
      .where('deployment_id', '=', id)
      .orderBy('seq')
      .execute();
  }

  scripts(t: TenantContext, id: string) {
    return tenantDb(this.db, t.schema)
      .selectFrom('deployment_scripts')
      .selectAll()
      .where('deployment_id', '=', id)
      .execute();
  }
}
