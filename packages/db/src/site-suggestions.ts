import { isCommonAreaPhone, type MixedSuggestion, type SiteSuggestion, type SiteSuggestions, type SuggestionKind } from '@tvmf/shared';
import { normalizeTeamsNumber } from './number-reconcile';
import type { Scoped } from './live-state';

/*
 * Which site a discovered object belongs to, judged by its phone number: each site owns number ranges (Data Collection > Numbers),
 * so an account, resource account, auto attendant or call queue whose number is in a site's range most likely belongs to that site.
 * An auto attendant or call queue has no number of its own; it takes the numbers of the resource accounts it lists.
 *
 * Only a suggestion: nothing here changes data. A person confirms it (Add to site), or the customer switches on automatic adding
 * (tenant_discovery_config.auto_add_by_number_range), which uses the same list.
 */

export type { SiteSuggestion, MixedSuggestion, SiteSuggestions, SuggestionKind };

type Rec = Record<string, unknown>;
const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

function accountNumbers(u: { line_uri: string | null; telephone_numbers: unknown }): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const n = normalizeTeamsNumber(v);
    if (n) out.add(n);
  };
  add(u.line_uri);
  if (Array.isArray(u.telephone_numbers)) for (const t of u.telephone_numbers as Rec[]) add(t.number);
  return [...out];
}

export async function siteSuggestions(s: Scoped): Promise<SiteSuggestions> {
  const [sites, owned] = await Promise.all([
    s.selectFrom('discovery_sites').select(['id', 'sitecode']).execute(),
    s.selectFrom('phone_numbers as n').innerJoin('discovery_number_ranges as r', 'r.id', 'n.range_id').select(['n.e164 as e164', 'r.sitecode as sitecode']).where('r.sitecode', 'is not', null).execute(),
  ]);
  const siteId = new Map(sites.map((x) => [x.sitecode, x.id]));
  const siteCode = new Map(sites.map((x) => [x.id, x.sitecode]));
  const siteOfNumber = new Map(owned.filter((o) => o.sitecode && siteId.has(o.sitecode)).map((o) => [o.e164, o.sitecode as string]));

  const items: SiteSuggestion[] = [];
  const mixed: MixedSuggestion[] = [];
  /** Decides one object: no number in a range = nothing to say; numbers in two sites' ranges = mixed; else the site and where it is now. */
  const judge = (base: Pick<SiteSuggestion, 'kind' | 'id' | 'label' | 'key' | 'as'>, numbers: string[], current: { site_id: string | null } | undefined) => {
    const hits = numbers.filter((n) => siteOfNumber.has(n));
    if (!hits.length) return false;
    const codes = [...new Set(hits.map((n) => siteOfNumber.get(n)!))];
    if (codes.length > 1) {
      mixed.push({ kind: base.kind, id: base.id, label: base.label, sitecodes: codes.sort() });
      return false;
    }
    const sitecode = codes[0]!;
    const sid = siteId.get(sitecode)!;
    if (current && !current.site_id) return false; // in Data Collection with no site: not ours to move
    if (current && current.site_id === sid) return false; // already where its number says
    items.push({
      ...base,
      numbers: hits,
      siteId: sid,
      sitecode,
      state: current ? 'other_site' : 'suggest',
      ...(current?.site_id ? { onSiteId: current.site_id, onSitecode: siteCode.get(current.site_id) ?? undefined } : {}),
    });
    return true;
  };

  // Accounts: users and common area phones.
  const users = await s
    .selectFrom('tenant_users')
    .select(['id', 'upn', 'display_name', 'line_uri', 'telephone_numbers', 'assigned_plans'])
    .where('removed_at', 'is', null)
    .where((eb) => eb.or([eb('account_type', '=', 'User'), eb('account_type', 'is', null)]))
    .execute();
  const [dcUsers, dcCaps] = await Promise.all([s.selectFrom('discovery_users').select(['upn', 'site_id']).execute(), s.selectFrom('discovery_caps').select(['upn', 'site_id']).execute()]);
  const userByUpn = new Map(dcUsers.map((d) => [lower(d.upn), d]));
  const capByUpn = new Map(dcCaps.filter((d) => d.upn).map((d) => [lower(d.upn), d]));
  for (const u of users) {
    const as: 'user' | 'cap' = isCommonAreaPhone(u.assigned_plans) ? 'cap' : 'user';
    const key = lower(u.upn);
    const current = (as === 'user' ? userByUpn.get(key) : capByUpn.get(key)) ?? (as === 'user' ? capByUpn.get(key) : userByUpn.get(key));
    judge({ kind: 'account', id: u.id, as, label: u.display_name ?? u.upn, key: u.upn }, accountNumbers(u), current);
  }

  // Voice apps and resource accounts.
  const objects = await s
    .selectFrom('tenant_objects')
    .select(['id', 'object_type', 'object_key', 'display_name', 'data'])
    .where('object_type', 'in', ['resource_account', 'auto_attendant', 'call_queue'])
    .where('removed_at', 'is', null)
    .execute();
  const [dcRas, dcApps] = await Promise.all([
    s.selectFrom('discovery_resource_accounts').select(['tenant_object_id', 'site_id']).where('tenant_object_id', 'is not', null).execute(),
    s.selectFrom('discovery_voice_apps').select(['tenant_object_id', 'site_id']).where('tenant_object_id', 'is not', null).execute(),
  ]);
  const raCurrent = new Map(dcRas.map((d) => [d.tenant_object_id!, d]));
  const appCurrent = new Map(dcApps.map((d) => [d.tenant_object_id!, d]));
  const ras = objects.filter((o) => o.object_type === 'resource_account');
  const raNumber = new Map<string, string>(); // lower(object_key) -> number
  for (const r of ras) {
    const n = normalizeTeamsNumber(String((r.data as Rec | null)?.PhoneNumber ?? '').replace(/^tel:/i, ''));
    if (n) raNumber.set(lower(r.object_key), n);
  }
  const ownedByApp = new Set<string>(); // resource accounts listed by a voice app that is itself suggested to the same site
  for (const o of objects.filter((x) => x.object_type !== 'resource_account')) {
    const inst = (o.data as Rec | null)?.ApplicationInstances;
    const nums = (Array.isArray(inst) ? inst : []).map((k) => raNumber.get(lower(k))).filter((n): n is string => !!n);
    const before = items.length;
    judge({ kind: o.object_type as 'auto_attendant' | 'call_queue', id: o.id, label: o.display_name ?? o.object_key, key: o.object_key }, nums, appCurrent.get(o.id));
    if (items.length > before && items[items.length - 1]!.state === 'suggest') for (const k of Array.isArray(inst) ? inst : []) ownedByApp.add(`${lower(k)}|${items[items.length - 1]!.sitecode}`);
  }
  for (const r of ras) {
    const n = raNumber.get(lower(r.object_key));
    if (!n) continue;
    const before = items.length;
    judge({ kind: 'resource_account', id: r.id, label: r.display_name ?? r.object_key, key: r.object_key }, [n], raCurrent.get(r.id));
    // adding its voice app brings it, so it is not listed on its own
    const added = items[items.length - 1];
    if (items.length > before && added!.state === 'suggest' && ownedByApp.has(`${lower(r.object_key)}|${added!.sitecode}`)) items.pop();
  }

  items.sort((a, b) => a.sitecode.localeCompare(b.sitecode) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  return { items, mixed };
}
