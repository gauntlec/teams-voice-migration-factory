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
 * Users tab searches). Stays `freeform`: a calling-settings target can be a
 * raw phone number or SIP address, not only a tenant user, so the dropdown
 * is a suggestion list, never a constraint on what can be typed/saved.
 */
export function UpnAutocomplete({
  tenantId,
  value,
  onChange,
  placeholder,
  style,
}: {
  tenantId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const term = useDebounced(value);

  const results = useQuery({
    queryKey: ['upn-autocomplete', tenantId, term],
    enabled: term.length >= 2,
    queryFn: () =>
      api<Paginated<TenantUserHit>>(
        `/t/${tenantId}/tenant-discovery/users?q=${encodeURIComponent(term)}&limit=8`,
      ),
  });
  const options = results.data?.items ?? [];

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
        </Option>
      ))}
    </Combobox>
  );
}
