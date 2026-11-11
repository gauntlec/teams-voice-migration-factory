import type { Kysely } from 'kysely';
import { platformDb, tenantDb, webOrigin as resolveWebOrigin, type DB } from '@tvmf/db';
import { handoverActionOverdue, type DiscoverySiteOverview, type HandoverActionsReminderContext } from '@tvmf/shared';
import type { MailEnqueuer } from './mail/enqueue';

/*
 * Service Handover reminders (docs/HANDOVER-VIEW.md step 4). An outstanding action still open the customer's reminder interval after
 * it was added (`tenants.handover_reminder_days`, default 7, 0 = off) is overdue. Each person to tell gets one email per customer
 * listing their overdue actions, and each action is reminded again only once the interval has passed since its last reminder.
 *
 * Who is told about a site's action (decided 10 Nov 2026): the site's Provider PM(s) from the Site Overview - users, or typed names with
 * an email - and whoever generated the site's newest pack. An all-sites action prints in every site's pack, so it goes to all of them.
 * The menu shows the overdue count too (HandoverService.overdue), so this works with email switched off.
 */

const DAY = 86_400_000;

interface Recipient {
  email: string;
  name: string | null;
}

export async function sweepHandoverReminders(db: Kysely<DB>, enqueueMail: MailEnqueuer, opts: { tenantId?: string; now?: Date } = {}): Promise<{ emails: number; actions: number }> {
  const now = opts.now ?? new Date();
  const origin = await resolveWebOrigin(db);
  let q = platformDb(db).selectFrom('tenants').select(['id', 'schema_name', 'name', 'handover_reminder_days']).where('status', '=', 'active').where('handover_reminder_days', '>', 0);
  if (opts.tenantId) q = q.where('id', '=', opts.tenantId);
  const total = { emails: 0, actions: 0 };
  for (const tenant of await q.execute()) {
    try {
      const r = await remindCustomer(db, enqueueMail, tenant, origin, now);
      total.emails += r.emails;
      total.actions += r.actions;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[handover] reminder sweep failed for ${tenant.schema_name}: ${(e as Error).message}`);
    }
  }
  if (total.emails) {
    // eslint-disable-next-line no-console
    console.log(`handover reminder sweep: ${total.emails} email(s) about ${total.actions} action(s)`);
  }
  return total;
}

async function remindCustomer(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  tenant: { id: string; schema_name: string; name: string; handover_reminder_days: number },
  origin: string | null,
  now: Date,
): Promise<{ emails: number; actions: number }> {
  const days = tenant.handover_reminder_days;
  const s = tenantDb(db, tenant.schema_name);
  const open = await s
    .selectFrom('handover_actions')
    .select(['id', 'site_id', 'description', 'owner', 'created_at', 'done_at', 'last_reminded_at'])
    .where('done_at', 'is', null)
    .orderBy('position')
    .orderBy('created_at')
    .execute();
  const due = open.filter((a) => handoverActionOverdue(a, days, now) && (!a.last_reminded_at || now.getTime() - new Date(a.last_reminded_at).getTime() >= days * DAY));
  if (due.length === 0) return { emails: 0, actions: 0 };

  const sites = await s.selectFrom('discovery_sites').select(['id', 'sitecode', 'name', 'overview']).orderBy('sitecode').execute();
  const packs = await s.selectFrom('handover_packs').select(['version', 'generated_by', 'source']).orderBy('version', 'desc').execute();
  // whoever generated each site's newest pack (packs for that one site), and the newest all-sites pack
  const generatorOf = new Map<string | null, string>();
  for (const p of packs) {
    const ids = ((p.source ?? {}) as { siteIds?: string[] }).siteIds ?? [];
    const key = ids.length === 1 ? ids[0]! : ids.length === 0 ? null : undefined;
    if (key !== undefined && !generatorOf.has(key)) generatorOf.set(key, p.generated_by);
  }

  // Provider PMs: the overview's contacts, or (older overviews) the project managers among its assigned staff
  const userIds = new Set<string>(generatorOf.values());
  const overviews = new Map(sites.map((x) => [x.id, (x.overview ?? {}) as DiscoverySiteOverview]));
  for (const o of overviews.values()) for (const id of o.contacts ? (o.contacts.providerPm ?? []).map((c) => c.userId) : (o.assignedUserIds ?? [])) if (id) userIds.add(id);
  const users = new Map(
    userIds.size ? (await platformDb(db).selectFrom('users').select(['id', 'email', 'display_name', 'role', 'status']).where('id', 'in', [...userIds]).execute()).map((u) => [u.id, u] as const) : [],
  );
  const activeUser = (id: string | undefined): Recipient | null => {
    const u = id ? users.get(id) : undefined;
    return u && u.status === 'active' ? { email: u.email, name: u.display_name } : null;
  };
  const recipientsOf = (siteId: string): Recipient[] => {
    const o = overviews.get(siteId) ?? {};
    const pms = o.contacts
      ? (o.contacts.providerPm ?? []).map((c) => (c.userId ? activeUser(c.userId) : c.email ? { email: c.email, name: c.name || null } : null))
      : (o.assignedUserIds ?? []).filter((id) => users.get(id)?.role === 'PROJECT_MANAGER').map((id) => activeUser(id));
    return [...pms, activeUser(generatorOf.get(siteId))].filter((r): r is Recipient => !!r);
  };

  const siteUrl = (siteId: string) => `${origin ?? ''}/handover/sites/${siteId}`;
  const listUrl = `${origin ?? ''}/handover`;
  const byRecipient = new Map<string, { to: Recipient; sites: Map<string, HandoverActionsReminderContext['sites'][number]> }>();
  const remindedIds = new Set<string>();
  const add = (to: Recipient, group: { key: string; sitecode: string | null; siteName: string | null; url: string }, a: (typeof due)[number]) => {
    const k = to.email.toLowerCase();
    const entry = byRecipient.get(k) ?? { to, sites: new Map<string, HandoverActionsReminderContext['sites'][number]>() };
    byRecipient.set(k, entry);
    const g = entry.sites.get(group.key) ?? { sitecode: group.sitecode, siteName: group.siteName, url: group.url, actions: [] };
    entry.sites.set(group.key, g);
    if (!g.actions.some((x) => x.description === a.description && x.owner === a.owner)) {
      g.actions.push({ description: a.description, owner: a.owner, daysOpen: Math.floor((now.getTime() - new Date(a.created_at).getTime()) / DAY) });
    }
    remindedIds.add(a.id);
  };
  const siteById = new Map(sites.map((x) => [x.id, x]));
  for (const a of due) {
    if (a.site_id) {
      const site = siteById.get(a.site_id);
      if (!site) continue;
      for (const to of recipientsOf(site.id)) add(to, { key: site.id, sitecode: site.sitecode, siteName: site.name, url: siteUrl(site.id) }, a);
    } else {
      const everyone = [...sites.flatMap((x) => recipientsOf(x.id)), activeUser(generatorOf.get(null))].filter((r): r is Recipient => !!r);
      for (const to of everyone) add(to, { key: '', sitecode: null, siteName: null, url: listUrl }, a);
    }
  }

  for (const { to, sites: groups } of byRecipient.values()) {
    // the site's own actions first in site-code order, then the all-sites ones
    const ordered = [...groups.values()].sort((x, y) => (x.sitecode === null ? 1 : y.sitecode === null ? -1 : x.sitecode.localeCompare(y.sitecode)));
    const context: HandoverActionsReminderContext = { recipientName: to.name, customerName: tenant.name, days, listUrl, sites: ordered };
    await enqueueMail({ template: 'handover_actions_reminder', to, context, tenantId: tenant.id });
  }
  // Only actions someone was told about count as reminded: one with nobody to tell stays due (and on the menu's count).
  if (remindedIds.size) await s.updateTable('handover_actions').set({ last_reminded_at: now.toISOString() }).where('id', 'in', [...remindedIds]).execute();
  return { emails: byRecipient.size, actions: remindedIds.size };
}
