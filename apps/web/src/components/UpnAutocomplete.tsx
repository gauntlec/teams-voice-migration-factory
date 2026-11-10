import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combobox, Link, Option, Text, tokens } from '@fluentui/react-components';
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
 * own Site Data Users tab (discovery_users) - a greenfield site often
 * has people typed in there long before a live tenant sync ever runs, so
 * restricting suggestions to tenant_users alone would offer nothing for it.
 * A discovery_users-only hit (not already live) is labelled "not yet
 * synced" so it's clear the UPN hasn't been confirmed against the tenant.
 * Stays `freeform` either way: a calling-settings target can be a raw phone
 * number or SIP address, not only a person, so the dropdown is a
 * suggestion list, never a constraint on what can be typed/saved.
 *
 * Searching uses only the part before the @, so a full address that is close to a real one still offers the real one (bug report
 * "UPN Mismatch": typing first.last@ offered nothing when the person is first.last1@, and it was saved as typed). An address that is
 * not a user in Teams gets a note under the field, with the nearest match to use instead.
 */
export function UpnAutocomplete({
  tenantId,
  siteId,
  value,
  onChange,
  placeholder,
  style,
  className,
}: {
  tenantId: string;
  /** Also suggest this site's own Site Data Users tab entries, not just the live tenant sync. */
  siteId?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const settled = useDebounced(value);
  const term = settled.includes('@') ? settled.slice(0, settled.indexOf('@')) : settled;

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

  // Only an email-shaped value is checked: this field also takes phone numbers and SIP addresses, which are never users.
  const typed = value.trim();
  const looksLikeUpn = /^[^@\s:]+@[^@\s]+$/.test(typed);
  const checked = looksLikeUpn && settled === value && live.isSuccess && !live.isFetching;
  const inTeams = options.some((o) => o.synced && o.upn.toLowerCase() === typed.toLowerCase());
  const inSiteData = options.some((o) => !o.synced && o.upn.toLowerCase() === typed.toLowerCase());
  const nearest = options.find((o) => o.synced && o.upn.toLowerCase() !== typed.toLowerCase());
  const note =
    checked && !inTeams ? (
      <Text size={200} style={{ color: inSiteData ? tokens.colorNeutralForeground3 : tokens.colorStatusWarningForeground1, width: 0, minWidth: '100%' }}>
        {inSiteData ? 'In Site Data, not found in Teams yet.' : 'Not a user in Teams.'}
        {nearest && (
          <>
            {' '}
            <Link as="button" onClick={() => onChange(nearest.upn)}>
              Use {nearest.upn}
            </Link>
          </>
        )}
      </Text>
    ) : null;

  return (
    <span className={className} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, ...style }}>
      <Combobox
        freeform
        value={value}
        placeholder={placeholder}
        style={{ width: '100%', minWidth: 0 }}
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
      {note}
    </span>
  );
}
