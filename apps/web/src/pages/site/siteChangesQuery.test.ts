import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { siteChangesKeyPrefix, siteChangesQuery, type SiteChange, type SiteChangesList } from './siteChangesQuery';

/**
 * The Site Data page reads the site summary (with its "N changed since submitted" count) again after every edit, and
 * SiteChangesCard turns the count into a query with siteChangesQuery. These tests drive React Query the way the card does
 * (one observer whose options are set again on each render) against a fake server, without a browser.
 */

const base = '/api/t/tenant-1/data-collection';
const siteId = 'site-1';

function fakeServer() {
  const rows: SiteChange[] = [];
  let reads = 0;
  return {
    reads: () => reads,
    // What the API does for PATCH .../numbers/:id/park on a submitted site: one change row per number.
    park(number: string, parked: boolean) {
      rows.unshift({
        id: `c${rows.length + 1}`,
        changed_at: new Date().toISOString(),
        actor_name: 'Engineer',
        entity: 'Number',
        entity_label: number,
        action: 'changed',
        detail: parked ? 'parked' : 'unparked',
      });
    },
    acknowledge() {
      rows.length = 0;
    },
    pending: () => rows.length,
    list: async (): Promise<SiteChangesList> => {
      reads++;
      return { items: rows.map((r) => ({ ...r })), total: rows.length };
    },
  };
}

/** The card as React renders it: one observer, its options set again with the summary's latest count. */
function mountCard(qc: QueryClient, server: ReturnType<typeof fakeServer>) {
  const observer = new QueryObserver(qc, siteChangesQuery(base, siteId, server.pending(), server.list));
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    rerender: () => observer.setOptions(siteChangesQuery(base, siteId, server.pending(), server.list)),
    settled: async () => {
      // Let the fetch the new options started finish.
      for (let i = 0; i < 20 && observer.getCurrentResult().isFetching; i++) await new Promise((r) => setTimeout(r, 0));
      return observer.getCurrentResult().data;
    },
    current: () => observer.getCurrentResult(),
    unmount: unsubscribe,
  };
}

const numbers = ['+441410000001', '+441410000002', '+441410000003', '+441410000004', '+441410000005'];

describe('Changed since submitted list (bug report "Screen Refresh")', () => {
  it('lists all five numbers un-parked one after another, not just the first', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const server = fakeServer();

    // First un-park: the count goes from 0 to 1, so the card appears and reads the list.
    server.park(numbers[0], false);
    const card = mountCard(qc, server);
    expect((await card.settled())?.items).toHaveLength(1);

    // The other four: after each, the page reads the summary again and the card renders with the new count.
    for (const n of numbers.slice(1)) {
      server.park(n, false);
      card.rerender();
    }
    const data = await card.settled();
    expect(data?.total).toBe(5);
    expect(data?.items.map((c) => c.entity_label).sort()).toEqual([...numbers].sort());
    card.unmount();
  });

  it('picks up parking too, when the card is already showing earlier changes', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const server = fakeServer();
    server.park('+441410000099', false);
    const card = mountCard(qc, server);
    expect((await card.settled())?.items).toHaveLength(1);

    for (const n of numbers) {
      server.park(n, true);
      card.rerender();
    }
    const data = await card.settled();
    expect(data?.items).toHaveLength(6);
    expect(data?.items.filter((c) => c.detail === 'parked')).toHaveLength(5);
    card.unmount();
  });

  it('keeps the rows on screen while the longer list loads, and does not read again when nothing changed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const server = fakeServer();
    server.park(numbers[0], false);
    const card = mountCard(qc, server);
    await card.settled();
    const readsBefore = server.reads();

    // A summary refresh with the same count (an edit on another tab that changed nothing here) reads nothing new.
    card.rerender();
    await card.settled();
    expect(server.reads()).toBe(readsBefore);

    server.park(numbers[1], false);
    card.rerender();
    // While the new list is on its way the old rows are still there (no spinner flash).
    expect(card.current().isLoading).toBe(false);
    expect(card.current().isPlaceholderData).toBe(true);
    expect(card.current().data?.items).toHaveLength(1);
    expect((await card.settled())?.items).toHaveLength(2);
    expect(server.reads()).toBe(readsBefore + 1);
    card.unmount();
  });

  it('marking as reviewed reads the list again through the shared key prefix', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const server = fakeServer();
    for (const n of numbers) server.park(n, false);
    const card = mountCard(qc, server);
    expect((await card.settled())?.items).toHaveLength(5);

    server.acknowledge();
    await qc.invalidateQueries({ queryKey: siteChangesKeyPrefix(base, siteId) });
    expect((await card.settled())?.items).toHaveLength(0);
    card.unmount();
  });
});
