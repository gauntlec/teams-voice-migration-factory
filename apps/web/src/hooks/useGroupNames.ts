import { useQueries } from '@tanstack/react-query';
import type { Paginated, TenantGroupSummary } from '@tvmf/shared';
import { api } from '../api';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The display names of M365 groups (Shared Voicemail targets are stored as the group's Object ID), read from the customer's cached group
 * list (`GET /t/:id/tenant-discovery/groups`, filled by the optional Microsoft Graph sign-in on Discovery). Keyed by the lower-case id.
 * A value that is not an id, or a group that is not in the cache (Graph not connected, or the group is newer than the last sync), gets no
 * entry: show the id itself then.
 */
export function useGroupNames(tenantId: string | null | undefined, ids: string[]): Record<string, string> {
  const wanted = [...new Set(ids.map((i) => i.trim().toLowerCase()).filter((i) => GUID.test(i)))];
  const results = useQueries({
    queries: wanted.map((id) => ({
      queryKey: ['group-name', tenantId, id],
      enabled: !!tenantId,
      staleTime: 5 * 60_000,
      queryFn: async (): Promise<string | null> => {
        const r = await api<Paginated<TenantGroupSummary>>(`/t/${tenantId}/tenant-discovery/groups?q=${encodeURIComponent(id)}&limit=5`);
        return r.items.find((g) => g.object_id.toLowerCase() === id)?.display_name ?? null;
      },
    })),
  });
  const names: Record<string, string> = {};
  wanted.forEach((id, i) => {
    const name = results[i]?.data;
    if (name) names[id] = name;
  });
  return names;
}
