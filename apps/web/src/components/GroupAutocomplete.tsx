import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combobox, Option } from '@fluentui/react-components';
import type { Paginated, TenantGroupSummary } from '@tvmf/shared';
import { api } from '../api';
import { useDebounced } from '../hooks/useDebounced';
import { useGroupNames } from '../hooks/useGroupNames';

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
  className,
}: {
  tenantId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const term = useDebounced(value);
  // The value is the group's Object ID, but a person should see its name: the one just picked, else looked up in the cache. While the
  // person is typing (or when the group is not in the cache) the text shown is exactly what is in the field.
  const [typing, setTyping] = useState(false);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const key = value.trim().toLowerCase();
  const looked = useGroupNames(tenantId, [value])[key];
  const name = picked && picked.id.toLowerCase() === key ? picked.name : looked;
  const shown = !typing && name ? name : value;

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
      value={shown}
      placeholder={placeholder ?? '00000000-0000-0000-0000-000000000000'}
      style={style}
      className={className}
      input={{ title: name ? `${name} (${value})` : undefined, onBlur: () => setTyping(false) }}
      onChange={(e) => {
        setTyping(true);
        onChange(e.target.value);
      }}
      onOptionSelect={(_, data) => {
        const group = options.find((g) => g.object_id === data.optionValue);
        if (group) setPicked({ id: group.object_id, name: group.display_name });
        setTyping(false);
        onChange(group?.object_id ?? data.optionValue ?? '');
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
