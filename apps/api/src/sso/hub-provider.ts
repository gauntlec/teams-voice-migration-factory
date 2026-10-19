import type { Kysely } from 'kysely';
import { platformDb, type DB } from '@tvmf/db';
import { HUB_PROVIDER_NAME, instanceIdFromHubToken } from '@tvmf/shared';
import { AuditService } from '../common/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto';

/**
 * Keeps the `hub` single sign-on provider in step with the hub connection (docs/SSO.md 4.1): issuer = the hub address, client id = this
 * installation's id at the hub (it is inside the instance token), client secret = the instance token. It is created SWITCHED OFF: an
 * administrator of this installation turns hub sign-in on in Platform settings > Single sign-on.
 *
 * Changing the token or the instance keeps the switch and the role ceilings as they were. Pointing the connection at a DIFFERENT hub is
 * a different identity provider, so the switch goes off, the people it knew are forgotten and their sessions end: a subject id from one
 * hub must never be taken to mean the same person at another.
 */
export async function syncHubProvider(db: Kysely<DB>, hubUrl: string, token: string, userId: string | null): Promise<void> {
  const clientId = instanceIdFromHubToken(token);
  if (!clientId) return; // the connection form already refuses anything that is not an instance token
  const p = platformDb(db);
  const audit = new AuditService(db);
  const existing = await p.selectFrom('sso_providers').select(['id', 'issuer', 'enabled']).where('kind', '=', 'hub').executeTakeFirst();
  const secret = encryptSecret(token);

  if (!existing) {
    const created = await p
      .insertInto('sso_providers')
      .values({ kind: 'hub', name: HUB_PROVIDER_NAME, issuer: hubUrl, client_id: clientId, client_secret_enc: secret, enabled: false, created_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit.platform('sso.provider.changed', {
      actor: { id: userId },
      targetType: 'sso_provider',
      targetId: created.id,
      detail: { kind: 'hub', change: 'created from the hub connection', enabled: false },
    });
    return;
  }

  const differentHub = existing.issuer.replace(/\/+$/, '') !== hubUrl.replace(/\/+$/, '');
  await p
    .updateTable('sso_providers')
    .set({ issuer: hubUrl, client_id: clientId, client_secret_enc: secret, ...(differentHub ? { enabled: false } : {}), updated_at: new Date().toISOString() })
    .where('id', '=', existing.id)
    .execute();
  if (differentHub) {
    await p.deleteFrom('external_identities').where('provider_id', '=', existing.id).execute();
    await p.deleteFrom('sso_link_requests').where('provider_id', '=', existing.id).execute();
    await p.updateTable('auth_sessions').set({ revoked_at: new Date().toISOString() }).where('idp', '=', existing.id).where('revoked_at', 'is', null).execute();
  }
  await audit.platform('sso.provider.changed', {
    actor: { id: userId },
    targetType: 'sso_provider',
    targetId: existing.id,
    detail: { kind: 'hub', change: differentHub ? 'hub address changed: switched off, people forgotten' : 'hub connection updated', enabled: differentHub ? false : existing.enabled },
  });
}

/** Disconnecting from the hub switches hub sign-in off (people already signed in are signed out at their next token refresh). */
export async function hubDisconnected(db: Kysely<DB>, userId: string | null): Promise<void> {
  const r = await platformDb(db)
    .updateTable('sso_providers')
    .set({ enabled: false, updated_at: new Date().toISOString() })
    .where('kind', '=', 'hub')
    .where('enabled', '=', true)
    .returning('id')
    .executeTakeFirst();
  if (r) {
    await new AuditService(db).platform('sso.provider.changed', {
      actor: { id: userId },
      targetType: 'sso_provider',
      targetId: r.id,
      detail: { kind: 'hub', change: 'switched off because the hub was disconnected', enabled: false },
    });
  }
}

/**
 * Makes sure the `hub` provider record exists whenever a hub connection does (hub address + token saved). Installations connected to a hub
 * BEFORE single sign-on existed have the connection but no provider record, and the token is stored masked so an administrator could not
 * simply reconnect to create it. Safe to call any number of times and at any moment: it creates the record (switched OFF, from the saved
 * connection) only when there is none, and never touches an existing one, so a switch or ceiling an administrator chose is never reset.
 * Returns true when it created the record.
 */
export async function ensureHubProvider(db: Kysely<DB>): Promise<boolean> {
  const p = platformDb(db);
  if (await p.selectFrom('sso_providers').select('id').where('kind', '=', 'hub').executeTakeFirst()) return false;
  const conn = await p.selectFrom('app_settings').select(['hub_url', 'hub_token_enc']).executeTakeFirst();
  if (!conn?.hub_url || !conn.hub_token_enc) return false;
  let token: string;
  try {
    token = decryptSecret(conn.hub_token_enc);
  } catch {
    return false; // an unreadable token (a changed encryption key) cannot be turned into a client secret; reconnecting fixes it
  }
  try {
    await syncHubProvider(db, conn.hub_url, token, null);
  } catch (err) {
    // Another process created it a moment ago (one hub provider per installation): that is the outcome wanted.
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
  return true;
}
