import { Global, Injectable, Module } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { InjectDb, type Db } from '../db/db.module';
import { redact } from './crypto';

export interface AuditActor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@InjectDb() private readonly db: Db) {}

  async platform(
    action: string,
    opts: {
      actor?: AuditActor;
      targetType?: string;
      targetId?: string;
      tenantId?: string;
      detail?: unknown;
    } = {},
  ): Promise<void> {
    await platformDb(this.db)
      .insertInto('platform_audit_log')
      .values({
        action,
        actor_user_id: opts.actor?.id ?? null,
        actor_email: opts.actor?.email ?? null,
        target_type: opts.targetType ?? null,
        target_id: opts.targetId ?? null,
        tenant_id: opts.tenantId ?? null,
        detail: redact(opts.detail ?? {}) as object,
        ip: opts.actor?.ip ?? null,
      })
      .execute();
  }

  async tenant(
    schema: string,
    action: string,
    opts: { actor?: AuditActor; targetType?: string; targetId?: string; detail?: unknown } = {},
  ): Promise<void> {
    await tenantDb(this.db, schema)
      .insertInto('audit_log')
      .values({
        action,
        actor_user_id: opts.actor?.id ?? null,
        actor_email: opts.actor?.email ?? null,
        target_type: opts.targetType ?? null,
        target_id: opts.targetId ?? null,
        detail: redact(opts.detail ?? {}) as object,
      })
      .execute();
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
