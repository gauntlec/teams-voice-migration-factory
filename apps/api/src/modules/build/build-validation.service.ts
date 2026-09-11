import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { tenantDb, type DB } from '@tvmf/db';
import { POLICY_KINDS, POLICY_KIND_TO_TENANT_TYPE, type BuildRowValidation, type PolicyKey } from '@tvmf/shared';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

type Scoped = ReturnType<typeof tenantDb>;

interface IdentityRow {
  id: string;
  upn: string;
  e164: string | null;
  policies: Record<string, string | null> | null;
}

/**
 * Live-vs-target validation for build_users/build_caps rows - the replacement
 * for the build workbook's manually-refreshed `G-*` columns. Everything it
 * compares against is already collected by Discovery (tenant_users,
 * tenant_policies) or is other build_* rows in the same tenant (duplicate
 * number detection); this never talks to the customer tenant itself.
 */
@Injectable()
export class BuildValidationService {
  constructor(@InjectDb() private readonly db: Db) {}
  private s(t: TenantContext): Scoped {
    return tenantDb(this.db, t.schema);
  }

  /** Batched so a whole grid validates in a handful of queries, not one per row. */
  async validateRows(t: TenantContext, rows: IdentityRow[]): Promise<Map<string, BuildRowValidation>> {
    const s = this.s(t);
    const out = new Map<string, BuildRowValidation>();
    if (rows.length === 0) return out;

    const upns = [...new Set(rows.map((r) => r.upn.toLowerCase()))];
    const tenantUsers = upns.length
      ? await s
          .selectFrom('tenant_users')
          .select(['upn', 'enterprise_voice_enabled', 'line_uri', 'policies'])
          .where('removed_at', 'is', null)
          .where(sql`lower(upn)`, 'in', upns)
          .execute()
      : [];
    const byUpn = new Map(tenantUsers.map((u) => [u.upn.toLowerCase(), u]));

    // Every distinct target policy value in play, grouped by the tenant policy
    // type it would be granted against, so "does this policy exist" is one
    // query per type instead of one per row per policy.
    const targetsByType = new Map<string, Set<string>>();
    for (const row of rows) {
      for (const kind of POLICY_KINDS) {
        const value = row.policies?.[kind.key];
        const tenantType = POLICY_KIND_TO_TENANT_TYPE[kind.key];
        if (!value || !tenantType) continue;
        if (!targetsByType.has(tenantType)) targetsByType.set(tenantType, new Set());
        targetsByType.get(tenantType)!.add(value);
      }
    }
    const knownPolicyNames = new Set<string>(); // "type::name"
    for (const [policyType, names] of targetsByType) {
      const found = await s
        .selectFrom('tenant_policies')
        .select('name')
        .where('policy_type', '=', policyType)
        .where('removed_at', 'is', null)
        .where('name', 'in', [...names])
        .execute();
      for (const f of found) knownPolicyNames.add(`${policyType}::${f.name}`);
    }

    // Design & Build imports a *copy* of the number Data Collection already
    // assigned (see BuildService.populateUsers/populateCaps) - it doesn't
    // take over the claim, so the phone_numbers inventory can no longer tell
    // us "does another build row have this too". Count occurrences directly
    // across every build_users/build_caps/build_resource_accounts row in the
    // tenant instead (not just this batch, and not just this site - a
    // duplicate assignment across two sites is just as real a problem at
    // deployment time).
    const e164s = [...new Set(rows.map((r) => r.e164).filter((v): v is string => !!v))];
    const dupeCounts = new Map<string, number>();
    if (e164s.length) {
      const [uRows, cRows, raRows] = await Promise.all([
        s.selectFrom('build_users').select('e164').where('e164', 'in', e164s).execute(),
        s.selectFrom('build_caps').select('e164').where('e164', 'in', e164s).execute(),
        s.selectFrom('build_resource_accounts').select('phone_number as e164').where('phone_number', 'in', e164s).execute(),
      ]);
      for (const r of [...uRows, ...cRows, ...raRows]) {
        if (!r.e164) continue;
        dupeCounts.set(r.e164, (dupeCounts.get(r.e164) ?? 0) + 1);
      }
    }

    for (const row of rows) {
      const live = byUpn.get(row.upn.toLowerCase());
      const policyMismatches: BuildRowValidation['policyMismatches'] = [];
      const unknownPolicies: BuildRowValidation['unknownPolicies'] = [];
      const untracked: PolicyKey[] = [];
      for (const kind of POLICY_KINDS) {
        const value = row.policies?.[kind.key];
        if (!value) continue;
        const tenantType = POLICY_KIND_TO_TENANT_TYPE[kind.key];
        if (!tenantType) {
          untracked.push(kind.key);
          continue;
        }
        if (!knownPolicyNames.has(`${tenantType}::${value}`)) {
          unknownPolicies.push({ key: kind.key, label: kind.label, value });
        }
        const liveValue = (live?.policies as Record<string, string | null> | null)?.[tenantType] ?? null;
        if (liveValue !== value) {
          policyMismatches.push({ key: kind.key, label: kind.label, target: value, live: liveValue });
        }
      }
      out.set(row.id, {
        existsInTenant: !!live,
        enterpriseVoiceEnabled: live?.enterprise_voice_enabled ?? null,
        liveLineUri: live?.line_uri ?? null,
        numberConflict: !!row.e164 && (dupeCounts.get(row.e164) ?? 0) > 1,
        policyMismatches,
        unknownPolicies,
        untracked,
      });
    }
    return out;
  }
}
