import { sql } from 'kysely';
import { POLICY_KINDS, POLICY_KIND_TO_TENANT_TYPE, lineUriToNumber, policyMatchesLive, usageLocationMismatch, userAccountProblems, blockingIssues, type BuildRowValidation, type NumberChange, type PolicyKey } from '@tvmf/shared';
import type { Scoped } from './live-state';

export interface IdentityRow {
  id: string;
  upn: string;
  e164: string | null;
  number_type: string | null;
  policies: Record<string, string | null> | null;
  policy_ids: Record<string, string | null> | null;
  /** the site the row belongs to, for the usage location check */
  site_id?: string | null;
  /** the Site Data user this row came from, for the requested-number check (users only) */
  discovery_user_id?: string | null;
  /** the Site Data common area phone this row came from, for the number change check (CAPs only) */
  discovery_cap_id?: string | null;
  /** the engineer's accept/reject of a number change (build_users/build_caps.number_decision) */
  number_decision?: unknown;
  /** false for a resource account with no number: it needs no phone licence (default true) */
  needsPhoneLicence?: boolean;
}

/** Last 10 digits, the loose number match used everywhere else. */
const numKey = (v: string | null | undefined): string => String(v ?? '').replace(/\D/g, '').slice(-10);

/**
 * Live-vs-target validation for build_users/build_caps/build_resource_accounts rows - the replacement
 * for the build workbook's manually-refreshed `G-*` columns. Everything it compares against is already
 * collected by Discovery (tenant_users, tenant_policies) or is other build_* rows in the same tenant
 * (duplicate number detection); this never talks to the customer tenant itself. Shared by Design & Build
 * (which shows the result) and the deployment (which leaves out rows with a blocking issue).
 * Batched so a whole grid validates in a handful of queries, not one per row.
 */
export async function validateIdentityRows(s: Scoped, rows: IdentityRow[]): Promise<Map<string, BuildRowValidation>> {
    const out = new Map<string, BuildRowValidation>();
    if (rows.length === 0) return out;

    const upns = [...new Set(rows.map((r) => r.upn.toLowerCase()))];
    const tenantUsers = upns.length
      ? await s
          .selectFrom('tenant_users')
          .select(['upn', 'enterprise_voice_enabled', 'line_uri', 'policies', 'account_enabled', 'assigned_plans', 'feature_types', 'usage_location'])
          .where('removed_at', 'is', null)
          .where(sql`lower(upn)`, 'in', upns)
          .execute()
      : [];
    const byUpn = new Map(tenantUsers.map((u) => [u.upn.toLowerCase(), u]));

    // The country of each site, as the ISO code Teams uses for a usage location.
    const siteIds = [...new Set(rows.map((r) => r.site_id).filter((v): v is string => !!v))];
    const siteRows = siteIds.length ? await s.selectFrom('discovery_sites').select(['id', 'country', 'review_status']).where('id', 'in', siteIds).execute() : [];
    const siteCountry = new Map(siteRows.map((r) => [r.id, r.country] as const));
    const siteReview = new Map(siteRows.map((r) => [r.id, r.review_status] as const));

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

    // Rows with a policy_ids link (see BuildService.resolvePolicyIds) get
    // checked against the linked tenant_policies row directly instead of by
    // name - a rename doesn't break the link, it just makes the stored
    // policies.<key> text stale (surfaced separately as "renamed" below).
    const linkedIds = [
      ...new Set(rows.flatMap((r) => POLICY_KINDS.map((k) => r.policy_ids?.[k.key]).filter((v): v is string => !!v))),
    ];
    const linkedPolicies = linkedIds.length
      ? await s.selectFrom('tenant_policies').select(['id', 'name', 'policy_type', 'removed_at']).where('id', 'in', linkedIds).execute()
      : [];
    const byLinkedId = new Map(linkedPolicies.map((p) => [p.id, p]));

    // Design & Build imports a *copy* of the number Site Data already
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

    // What the customer asked for in Site Data vs what is assigned to them.
    const dUserIds = [...new Set(rows.map((r) => r.discovery_user_id).filter((v): v is string => !!v))];
    const requestedByDUser = new Map<string, { requested: string; assigned: string | null }>();
    if (dUserIds.length) {
      const dUsers = await s
        .selectFrom('discovery_users as u')
        .leftJoin('phone_numbers as n', (join) => join.onRef('n.holder_id', '=', 'u.id').on('n.holder_type', '=', 'user'))
        .select(['u.id as id', 'u.requested_number as requested_number', 'n.e164 as e164'])
        .where('u.id', 'in', dUserIds)
        .where('u.requested_number', 'is not', null)
        .execute();
      for (const u of dUsers) {
        const req = numKey(u.requested_number);
        if (req !== '' && req !== numKey(u.e164)) requestedByDUser.set(u.id, { requested: u.requested_number!, assigned: u.e164 });
      }
    }

    // The number Site Data assigned to each person. Only compared once the site has been submitted for
    // review: before that the design is still being shaped and a different number is no surprise.
    const assignedByHolder = new Map<string, string>();
    for (const [holderType, ids] of [
      ['user', dUserIds],
      ['cap', [...new Set(rows.map((r) => r.discovery_cap_id).filter((v): v is string => !!v))]],
    ] as const) {
      if (!ids.length) continue;
      const held = await s.selectFrom('phone_numbers').select(['holder_id', 'e164']).where('holder_type', '=', holderType).where('holder_id', 'in', ids).execute();
      for (const h of held) if (h.holder_id) assignedByHolder.set(`${holderType}:${h.holder_id}`, h.e164);
    }

    for (const row of rows) {
      const live = byUpn.get(row.upn.toLowerCase());
      const policyMismatches: BuildRowValidation['policyMismatches'] = [];
      const unknownPolicies: BuildRowValidation['unknownPolicies'] = [];
      const renamedPolicies: BuildRowValidation['renamedPolicies'] = [];
      const untracked: PolicyKey[] = [];
      for (const kind of POLICY_KINDS) {
        const value = row.policies?.[kind.key];
        if (!value) continue;
        const tenantType = POLICY_KIND_TO_TENANT_TYPE[kind.key];
        if (!tenantType) {
          untracked.push(kind.key);
          continue;
        }
        const linkedId = row.policy_ids?.[kind.key];
        const linked = linkedId ? byLinkedId.get(linkedId) : undefined;
        // effectiveTarget is what a deployment would actually grant right
        // now - the live name behind the link when one resolves, otherwise
        // the stored text. Used for the mismatch-vs-live-assignment check
        // below so a rename doesn't produce a false mismatch either.
        let effectiveTarget = value;
        if (linkedId) {
          if (!linked || linked.removed_at || linked.policy_type !== tenantType) {
            unknownPolicies.push({ key: kind.key, label: kind.label, value });
          } else {
            effectiveTarget = linked.name;
            if (linked.name !== value) {
              renamedPolicies.push({ key: kind.key, label: kind.label, storedName: value, liveName: linked.name });
            }
          }
        } else if (!knownPolicyNames.has(`${tenantType}::${value}`)) {
          unknownPolicies.push({ key: kind.key, label: kind.label, value });
        }
        const liveValue = (live?.policies as Record<string, string | null> | null)?.[tenantType] ?? null;
        // "Global" = no per-user assignment, which Teams reports as no value.
        if (!policyMatchesLive(effectiveTarget, liveValue)) {
          policyMismatches.push({ key: kind.key, label: kind.label, target: effectiveTarget, live: liveValue });
        }
      }
      const account = live
        ? userAccountProblems(
            { accountEnabled: live.account_enabled, assignedPlans: live.assigned_plans as unknown[] | undefined, featureTypes: live.feature_types ?? undefined },
            row.needsPhoneLicence ?? true,
          )
        : { accountDisabled: false, noPhoneLicence: false };
      // A designed number that differs from the live one, or from Site Data's once the site is submitted.
      let numberChange: NumberChange | null = null;
      if (row.e164) {
        const liveNumber = lineUriToNumber(live?.line_uri);
        const dcNumber = row.discovery_user_id ? assignedByHolder.get(`user:${row.discovery_user_id}`) : row.discovery_cap_id ? assignedByHolder.get(`cap:${row.discovery_cap_id}`) : undefined;
        const submitted = !!row.site_id && siteReview.get(row.site_id) !== undefined && siteReview.get(row.site_id) !== 'draft';
        const liveDiffers = !!liveNumber && numKey(liveNumber) !== numKey(row.e164);
        const dcDiffers = submitted && !!dcNumber && numKey(dcNumber) !== numKey(row.e164);
        if (liveDiffers || dcDiffers) {
          numberChange = { designed: row.e164, live: liveDiffers ? liveNumber : null, dataCollection: dcDiffers ? dcNumber! : null, decision: 'pending' };
          // a decision only stands for the very numbers it was made against
          const d = row.number_decision as { decision?: string; designed?: string; live?: string | null; dataCollection?: string | null } | null | undefined;
          if (
            d && (d.decision === 'accepted' || d.decision === 'rejected') &&
            numKey(d.designed) === numKey(numberChange.designed) &&
            numKey(d.live) === numKey(numberChange.live) &&
            numKey(d.dataCollection) === numKey(numberChange.dataCollection)
          ) {
            numberChange.decision = d.decision;
          }
        }
      }
      out.set(row.id, {
        existsInTenant: !!live,
        usageLocationMismatch: live ? usageLocationMismatch(live.usage_location, row.site_id ? siteCountry.get(row.site_id) : null) : null,
        accountDisabled: account.accountDisabled,
        noPhoneLicence: account.noPhoneLicence,
        enterpriseVoiceEnabled: live?.enterprise_voice_enabled ?? null,
        liveLineUri: live?.line_uri ?? null,
        numberConflict: !!row.e164 && (dupeCounts.get(row.e164) ?? 0) > 1,
        numberTypeMissing: !!row.e164 && !row.number_type,
        numberChange,
        requestedNumberMismatch: (row.discovery_user_id && requestedByDUser.get(row.discovery_user_id)) || null,
        policyMismatches,
        unknownPolicies,
        renamedPolicies,
        untracked,
      });
    }
    return out;
}

/**
 * Why a deployment leaves each of these rows out: the blocking issues, as sentences.
 * Rows that can be deployed are not in the map.
 */
export async function identitySkipReasons(s: Scoped, rows: IdentityRow[]): Promise<Map<string, string[]>> {
  const validated = await validateIdentityRows(s, rows);
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const reasons = blockingIssues(validated.get(row.id)).map((i) => i.detail);
    if (reasons.length) out.set(row.id, reasons);
  }
  return out;
}

/**
 * The rows whose number change the engineer rejected (and the decision still stands: neither number has moved since). A deployment
 * does not assign the designed number to these; the user keeps whatever number they have in Teams. `live` is that number, if any.
 */
export async function rejectedNumberChanges(s: Scoped, rows: IdentityRow[]): Promise<Map<string, { designed: string; live: string | null; dataCollection: string | null }>> {
  const out = new Map<string, { designed: string; live: string | null; dataCollection: string | null }>();
  const candidates = rows.filter((r) => (r.number_decision as { decision?: string } | null | undefined)?.decision === 'rejected');
  if (!candidates.length) return out;
  const validated = await validateIdentityRows(s, candidates);
  for (const r of candidates) {
    const nc = validated.get(r.id)?.numberChange;
    if (nc && nc.decision === 'rejected') out.set(r.id, { designed: nc.designed, live: nc.live, dataCollection: nc.dataCollection });
  }
  return out;
}
