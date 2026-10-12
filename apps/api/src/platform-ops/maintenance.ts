import { ConflictException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import {
  maintenanceFreezeMessage,
  viewMaintenanceNotice,
  type MaintenanceNotice,
  type MaintenanceNoticeView,
} from '@tvmf/shared';

/** pg hands timestamptz back as a Date; the API speaks ISO strings. */
export function iso(v: unknown): string {
  return new Date(v as string | Date).toISOString();
}

/** The current maintenance notice (platform.maintenance_notice), or null. */
export async function loadMaintenanceNotice(db: Kysely<DB>): Promise<MaintenanceNotice | null> {
  const row = await platformDb(db)
    .selectFrom('maintenance_notice as n')
    .leftJoin('users as u', 'u.id', 'n.created_by')
    .select(['n.message', 'n.starts_at', 'n.created_at', 'u.display_name'])
    .executeTakeFirst();
  if (!row) return null;
  return { message: row.message, startsAt: iso(row.starts_at), createdByName: row.display_name ?? null, createdAt: iso(row.created_at) };
}

/** The notice with its phase + countdown; null when there is none or it has lapsed. */
export async function currentMaintenance(db: Kysely<DB>, now: Date = new Date()): Promise<MaintenanceNoticeView | null> {
  return viewMaintenanceNotice(await loadMaintenanceNotice(db), now);
}

/**
 * Refuse to start new live work (a deployment run, a discovery run, a
 * customer-tenant sign-in) in the final minutes before a scheduled update -
 * the worker restart would end it. `what` completes "Starting a new ___".
 */
export async function assertNoMaintenanceFreeze(db: Kysely<DB>, what: string, now: Date = new Date()): Promise<void> {
  const view = await currentMaintenance(db, now);
  if (view?.phase === 'freeze') throw new ConflictException(maintenanceFreezeMessage(view, what));
}
