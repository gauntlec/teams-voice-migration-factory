import type { Kysely } from 'kysely';
import type { DB } from './schema';

/*
 * Each customer is one Microsoft tenant. Voxshift records which one, and a Teams sign-in that reaches any other tenant is refused before
 * the connection becomes active, so nothing is read from it or deployed to it (bug report "Delete All Data Button": a sign-in to another
 * company's tenant, made while this customer was selected, read that company's Teams into this customer).
 *
 * The tenant is recorded from the customer's discovered Get-CsTenant record when there is one, otherwise from its first sign-in.
 * "Delete discovered data" forgets it, so a wrong record can be cleared and the right tenant signed in to.
 */

export interface MicrosoftTenant {
  id: string;
  name: string | null;
}

export type MicrosoftTenantSource = 'recorded' | 'discovered';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const label = (t: MicrosoftTenant) => (t.name ? `${t.name} (${t.id})` : t.id);

async function customerRow(db: Kysely<DB>, schema: string) {
  return db
    .withSchema('platform')
    .selectFrom('tenants')
    .select(['id', 'name', 'teams_tenant_id', 'teams_tenant_name', 'teams_tenant_recorded_at'])
    .where('schema_name', '=', schema)
    .executeTakeFirst();
}

/** The tenant the customer's discovered data came from (Get-CsTenant), if any. */
async function discoveredTenant(db: Kysely<DB>, schema: string): Promise<MicrosoftTenant | null> {
  const row = await db
    .withSchema(schema)
    .selectFrom('tenant_objects')
    .select(['object_key', 'display_name'])
    .where('object_type', '=', 'tenant')
    .where('removed_at', 'is', null)
    .orderBy('discovered_at', 'desc')
    .executeTakeFirst();
  return row ? { id: row.object_key, name: row.display_name } : null;
}

/** The customer's Microsoft tenant as far as Voxshift knows it: the recorded one, else the one its discovered data came from. */
export async function customerMicrosoftTenant(
  db: Kysely<DB>,
  schema: string,
): Promise<(MicrosoftTenant & { source: MicrosoftTenantSource; recordedAt: string | null }) | null> {
  const c = await customerRow(db, schema);
  if (c?.teams_tenant_id) {
    return { id: c.teams_tenant_id, name: c.teams_tenant_name, source: 'recorded', recordedAt: c.teams_tenant_recorded_at ? new Date(c.teams_tenant_recorded_at).toISOString() : null };
  }
  const found = await discoveredTenant(db, schema);
  return found ? { ...found, source: 'discovered', recordedAt: null } : null;
}

function wrongTenantMessage(customer: string, signedIn: MicrosoftTenant, own: MicrosoftTenant) {
  return (
    `This sign-in reached the Microsoft tenant ${label(signedIn)}, but ${customer} is the Microsoft tenant ${label(own)}. ` +
    `Nothing was read from it or changed in it. Sign in with an account in ${customer}'s own tenant. ` +
    `If ${customer}'s recorded tenant is wrong, delete its discovered data on the Discovery page to clear it, then sign in again.`
  );
}

export class WrongMicrosoftTenantError extends Error {
  readonly code = 'wrong_microsoft_tenant';
}

/**
 * Checks a Teams sign-in against the customer's own Microsoft tenant. With none recorded yet, records the one the customer's
 * discovered data came from, or else this sign-in's. Throws WrongMicrosoftTenantError for any other tenant.
 */
export async function checkMicrosoftTenant(db: Kysely<DB>, schema: string, signedIn: MicrosoftTenant): Promise<'matched' | 'recorded'> {
  const c = await customerRow(db, schema);
  if (!c) throw new Error('This customer no longer exists.');
  let own: MicrosoftTenant | null = c.teams_tenant_id ? { id: c.teams_tenant_id, name: c.teams_tenant_name } : null;
  let outcome: 'matched' | 'recorded' = 'matched';
  if (!own) {
    const candidate = (await discoveredTenant(db, schema)) ?? signedIn;
    const recorded = await db
      .withSchema('platform')
      .updateTable('tenants')
      .set({ teams_tenant_id: candidate.id, teams_tenant_name: candidate.name, teams_tenant_recorded_at: new Date().toISOString() })
      .where('id', '=', c.id)
      .where('teams_tenant_id', 'is', null)
      .returning(['teams_tenant_id', 'teams_tenant_name'])
      .executeTakeFirst();
    // Another sign-in recorded one at the same moment: check against that.
    const now = recorded ?? (await customerRow(db, schema));
    own = { id: now!.teams_tenant_id!, name: now!.teams_tenant_name };
    outcome = 'recorded';
  }
  if (!same(own.id, signedIn.id)) throw new WrongMicrosoftTenantError(wrongTenantMessage(c.name, signedIn, own));
  return outcome;
}

/**
 * Checked again as a sync or deployment starts on a sign-in: why it must not run, or null. A sign-in that recorded no tenant (made before
 * this check) is refused; a customer whose record was cleared since the sign-in takes the sign-in's tenant again.
 */
export async function connectionTenantProblem(db: Kysely<DB>, schema: string, connectionId: string): Promise<string | null> {
  const conn = await db.withSchema(schema).selectFrom('connections').select(['ms_tenant_id', 'ms_tenant_name']).where('id', '=', connectionId).executeTakeFirst();
  if (!conn?.ms_tenant_id) return 'This sign-in did not record which Microsoft tenant it reached. Sign in to the customer tenant again.';
  try {
    await checkMicrosoftTenant(db, schema, { id: conn.ms_tenant_id, name: conn.ms_tenant_name });
    return null;
  } catch (e) {
    if (e instanceof WrongMicrosoftTenantError) return e.message;
    throw e;
  }
}

/** "Delete discovered data": the customer starts over, and its next sign-in (or sync) records its tenant again. */
export async function forgetMicrosoftTenant(db: Kysely<DB>, customerId: string) {
  await db
    .withSchema('platform')
    .updateTable('tenants')
    .set({ teams_tenant_id: null, teams_tenant_name: null, teams_tenant_recorded_at: null })
    .where('id', '=', customerId)
    .execute();
}
