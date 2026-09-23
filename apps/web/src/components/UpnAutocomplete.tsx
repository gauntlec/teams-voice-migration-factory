import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combobox, Option } from '@fluentui/react-components';
import type { Paginated } from '@tvmf/shared';
import { api } from '../api';
import { useDebounced } from '../hooks/useDebounced';

interface TenantUserHit {
  upn: string;
  display_name: string | null;
}

/**
 * Type-ahead UPN field, backed by the tenant's live synced users
 * (GET /t/:id/tenant-discovery/users - the same source Discovery's own
 * Users tab searches). When `siteId` is given, also searches that site's
 * own Data Collection Users tab (discovery_users) - a greenfield site often
 * has people typed in there long before a live tenant sync ever runs, so
 * restricting suggestions to tenant_users alone would offer nothing for it.
 * A discovery_users-only hit (not already live) is labelled "not yet
 * synced" so it's clear the UPN hasn't been confirmed against the tenant.
 * Stays `freeform` either way: a calling-settings target can be a raw phone
 * number or SIP address, not only a person, so the dropdown is a
 * suggestion list, never a constraint on what can be typed/saved.
 */
export function UpnAutocomplete({
  tenantId,
  siteId,
  value,
  onChange,
  placeholder,
  style,
}: {
  tenantId: string;
  /** Also suggest this site's own Data Collection Users tab entries, not just the live tenant sync. */
  siteId?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const term = useDebounced(value);

  const live = useQuery({
    queryKey: ['upn-autocomplete', tenantId, term],
    enabled: term.length >= 2,
    queryFn: () => api<Paginated<TenantUserHit>>(`/t/${tenantId}/tenant-discovery/users?q=${encodeURIComponent(term)}&limit=8`),
  });
  const collected = useQuery({
    queryKey: ['upn-autocomplete-discovery', tenantId, siteId, term],
    enabled: term.length >= 2 && !!siteId,
    queryFn: () =>
      api<Paginated<TenantUserHit>>(`/t/${tenantId}/discovery/users?siteId=${siteId}&q=${encodeURIComponent(term)}&limit=8`),
  });

  const options = useMemo(() => {
    const liveItems = (live.data?.items ?? []).map((u) => ({ ...u, synced: true }));
    const seen = new Set(liveItems.map((u) => u.upn.toLowerCase()));
    const collectedOnly = (collected.data?.items ?? [])
      .filter((u) => !seen.has(u.upn.toLowerCase()))
      .map((u) => ({ ...u, synced: false }));
    return [...liveItems, ...collectedOnly];
  }, [live.data, collected.data]);

  return (
    <Combobox
      freeform
      value={value}
      placeholder={placeholder}
      style={style}
      onChange={(e) => onChange(e.target.value)}
      onOptionSelect={(_, data) => onChange(data.optionText ?? data.optionValue ?? '')}
    >
      {options.map((u) => (
        <Option key={u.upn} value={u.upn} text={u.upn}>
          {u.display_name ? `${u.upn} — ${u.display_name}` : u.upn}
          {!u.synced && ' (not yet synced)'}
        </Option>
      ))}
    </Combobox>
  );
}
