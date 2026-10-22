/**
 * The people on a site, shown on the Site Overview in Data Collection. Five roles, each holding any number of people. A person is
 * either picked from the active users (`userId`) or typed as free text (`name` and/or `email`).
 */

export const SITE_CONTACT_ROLES = [
  { key: 'siteContacts', label: 'Site contact(s)' },
  { key: 'providerPm', label: 'Provider PM' },
  { key: 'providerEngineer', label: 'Provider Engineer' },
  { key: 'providerPortingPm', label: 'Provider Porting PM' },
  { key: 'providerPortingEngineer', label: 'Provider Porting Engineer' },
] as const;
export type SiteContactRole = (typeof SITE_CONTACT_ROLES)[number]['key'];

export const MAX_CONTACTS_PER_ROLE = 20;

export interface SiteContact {
  /** a platform user picked from the list */
  userId?: string;
  /** free text, when the person is not a user of the system */
  name?: string;
  email?: string;
}

export type SiteContacts = Partial<Record<SiteContactRole, SiteContact[]>>;

/** What a person is called on screen, given the name of the user when one was picked. */
export function contactLabel(c: SiteContact, userName?: string | null): string {
  if (c.userId) return userName || 'Unknown user';
  return c.name || c.email || '—';
}

export interface SiteContactTargets {
  /** users picked as Site contacts */
  userIds: string[];
  /** typed Site contacts that have an email address */
  typed: { email: string; name: string | null }[];
}

/**
 * Who a site's Site contact(s) are, for emails. Overviews saved before the roles existed only have `primaryContactEmail`,
 * which counts as the one typed Site contact until the overview is next saved.
 */
export function siteContactTargets(overview: { contacts?: SiteContacts; primaryContactEmail?: string } | null | undefined): SiteContactTargets {
  const list: SiteContact[] = overview?.contacts
    ? (overview.contacts.siteContacts ?? [])
    : overview?.primaryContactEmail
      ? [{ email: overview.primaryContactEmail }]
      : [];
  return {
    userIds: [...new Set(list.map((c) => c.userId).filter((v): v is string => !!v))],
    typed: list.filter((c) => !c.userId && c.email).map((c) => ({ email: c.email as string, name: c.name || null })),
  };
}

/** Every user id mentioned in any role. */
export function contactUserIds(contacts: SiteContacts | null | undefined): string[] {
  const ids = new Set<string>();
  for (const role of SITE_CONTACT_ROLES) for (const c of contacts?.[role.key] ?? []) if (c.userId) ids.add(c.userId);
  return [...ids];
}
