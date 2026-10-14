import { Injectable } from '@nestjs/common';
import { platformDb } from '@tvmf/db';
import { mspNotifyEnabled, type MspNotifyCard, type MspNotifyConfig, type MspNotifyKind } from '@tvmf/shared';
import { InjectDb, type Db } from '../../db/db.module';

/**
 * Queues a note for an MSP's Teams channel (docs/INTAKE.md): only if the customer's MSP has a channel connected and has not switched
 * this kind off. A queue, not a call: the worker posts it, so a slow or broken channel never delays an incident, and a failure here is
 * never allowed to fail the change that caused it.
 */
@Injectable()
export class MspNotifier {
  constructor(@InjectDb() private readonly db: Db) {}

  async enqueue(tenantId: string, kind: Exclude<MspNotifyKind, 'test'>, card: MspNotifyCard): Promise<boolean> {
    try {
      const row = await platformDb(this.db)
        .selectFrom('tenants as t')
        .innerJoin('msps as m', 'm.id', 't.msp_id')
        .select(['m.id as msp_id', 'm.teams_webhook_enc as hook', 'm.teams_notify as notify'])
        .where('t.id', '=', tenantId)
        .executeTakeFirst();
      if (!row?.hook || !mspNotifyEnabled(row.notify as Partial<MspNotifyConfig>, kind)) return false;
      await platformDb(this.db).insertInto('msp_notifications').values({ msp_id: row.msp_id, tenant_id: tenantId, kind, card: JSON.stringify(card) }).execute();
      return true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[msp-notify] could not queue ${kind}: ${(e as Error).message}`);
      return false;
    }
  }
}
