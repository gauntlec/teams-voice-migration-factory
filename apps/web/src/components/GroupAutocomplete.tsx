import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combobox, Option } from '@fluentui/react-components';
import type { Paginated, TenantGroupSummary } from '@tvmf/shared';
import { api } from '../api';
import { useDebounced } from '../hooks/useDebounced';

/**
 * Type-ahead M365 group field for the Shared Voicemail `groupId` target -
 * backed by this tenant's cached group list (`GET
 * /t/:id/tenant-discovery/groups`, populated once by the optional Microsoft
 * Graph sign-in on the Discovery page's "Connect to customer tenant" card -
 * see `ConnectCard`'s "Add group lookup"). Mirrors `UpnAutocomplete.tsx`:
 * stays `freeform`, so a raw Object ID typed or pasted directly is still a
 * valid value (Graph not connected yet, or the group predates the last
 * sync) - the suggestion list is a convenience, never a constraint on what
 * can be typed/saved.
 */
export function GroupAutocomplete({
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

  const search = useQuery({
    queryKey: ['group-autocomplete', tenantId, term],
    enabled: term.length >= 2,
    queryFn: () =>
      api<Paginated<TenantGroupSummary>>(`/t/${tenantId}/tenant-discovery/groups?q=${encodeURIComponent(term)}&limit=8`),
  });
  const options = useMemo(() => search.data?.items ?? [], [search.data]);

  return (
    <Combobox
      freeform
      value={value}
      placeholder={placeholder ?? '00000000-0000-0000-0000-000000000000'}
      style={style}
      onChange={(e) => onChange(e.target.value)}
      onOptionSelect={(_, data) => {
        const picked = options.find((g) => g.object_id === data.optionValue);
        onChange(picked?.object_id ?? data.optionValue ?? '');
      }}
    >
      {options.map((g) => (
        <Option key={g.object_id} value={g.object_id} text={g.display_name}>
          {g.display_name}
          {g.mail ? ` — ${g.mail}` : ''}
        </Option>
      ))}
    </Combobox>
  );
}
