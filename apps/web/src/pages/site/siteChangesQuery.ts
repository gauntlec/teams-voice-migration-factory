import { keepPreviousData, queryOptions } from '@tanstack/react-query';

export interface SiteChange {
  id: string;
  changed_at: string;
  actor_name: string | null;
  entity: string;
  entity_label: string | null;
  action: 'added' | 'changed' | 'removed';
  detail: string | null;
}

export interface SiteChangesList {
  items: SiteChange[];
  total: number;
}

/** Every cached "Changed since submitted" list for a site, whatever count it was read at: invalidate this to read it again. */
export const siteChangesKeyPrefix = (base: string, siteId: string) => ['site-changes', base, siteId] as const;

/**
 * The "Changed since submitted" list for a site.
 *
 * The site summary carries how many changes are waiting (`pendingChanges`) and is read again after every edit on the
 * page; this list is a separate request. The count is part of the key so that whenever the summary brings a new count
 * the list is read again too. Without it the list kept what it read when the card first appeared: un-parking five
 * numbers one after another showed "5 changed since submitted" over a table with only the first of them.
 * The previous rows stay on screen while the new ones load, so the table does not flash.
 */
export const siteChangesQuery = (base: string, siteId: string, pendingChanges: number, fetchList: () => Promise<SiteChangesList>) =>
  queryOptions({
    queryKey: [...siteChangesKeyPrefix(base, siteId), pendingChanges],
    queryFn: fetchList,
    placeholderData: keepPreviousData,
  });
