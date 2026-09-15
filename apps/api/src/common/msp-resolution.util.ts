import { sql } from 'kysely';
import { platformDb } from '@tvmf/db';
import type { Db } from '../db/db.module';

/**
 * Which MSP an ENGINEER/PROJECT_MANAGER belongs to. Domain match is the
 * primary mechanism (an org's engineers all share a corporate email
 * domain); the explicit per-user override is only a fallback for
 * personal/shared domains a domain match can't resolve. Shared by
 * AuthService.resolveMspBranding (app-chrome branding) and
 * UsersService.sendInvitation (invitation/reset email branding) - one
 * source of truth for the lookup.
 */
export async function resolveMspId(db: Db, email: string, mspIdOverride: string | null): Promise<string | null> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (domain) {
    const byDomain = await platformDb(db)
      .selectFrom('msps')
      .select('id')
      .where(sql<boolean>`${domain} = any(domains)`)
      .executeTakeFirst();
    if (byDomain) return byDomain.id;
  }
  if (mspIdOverride) {
    const byOverride = await platformDb(db).selectFrom('msps').select('id').where('id', '=', mspIdOverride).executeTakeFirst();
    if (byOverride) return byOverride.id;
  }
  return null;
}
