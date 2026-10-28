import { useState } from 'react';
import { Button, Input, Spinner, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import { isCoordinateText, parseCoordinatePair } from '@tvmf/shared';
import type { GeocodeConfig } from './records';

/** One extra address as the form holds it: every value a string, as the other fields do. */
export interface AddressEntry {
  label: string;
  address: string;
  latitude: string;
  longitude: string;
}

export const emptyAddress = (): AddressEntry => ({ label: '', address: '', latitude: '', longitude: '' });

/** The saved list (from the API) as the form's JSON text. */
export function addressesToText(v: unknown): string {
  const list = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  return JSON.stringify(
    list.map((a) => ({
      label: String(a.label ?? ''),
      address: String(a.address ?? ''),
      latitude: a.latitude == null ? '' : String(a.latitude),
      longitude: a.longitude == null ? '' : String(a.longitude),
    })),
  );
}

export function parseAddressText(text: string | undefined): AddressEntry[] {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? (v as AddressEntry[]) : [];
  } catch {
    return [];
  }
}

/** The form's JSON text as the API takes it: blank addresses dropped, coordinates as numbers (or null). */
export function addressesToPayload(text: string | undefined) {
  return parseAddressText(text)
    .filter((a) => a.address.trim())
    .map((a) => ({
      label: a.label.trim(),
      address: a.address.trim(),
      latitude: a.latitude.trim() === '' || Number.isNaN(Number(a.latitude)) ? null : Number(a.latitude),
      longitude: a.longitude.trim() === '' || Number.isNaN(Number(a.longitude)) ? null : Number(a.longitude),
    }));
}

const useStyles = makeStyles({
  list: { display: 'grid', rowGap: '12px' },
  entry: {
    display: 'grid',
    rowGap: '8px',
    padding: '10px 12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: '8px' },
  coords: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '8px' },
  actions: { display: 'flex', alignItems: 'center', columnGap: '8px', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
});

/**
 * The other addresses on a site - another building on a campus with its own civic address. Each has an optional label, the address
 * and coordinates (looked up from the address, or pasted/typed). They share the site's code and each is pinned on the site map.
 */
export function AddressListEditor({ value, onChange, geocode }: { value: string; onChange: (text: string) => void; geocode?: GeocodeConfig }) {
  const s = useStyles();
  const list = parseAddressText(value);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ at: number; text: string } | null>(null);
  const set = (next: AddressEntry[]) => onChange(JSON.stringify(next));
  const patch = (i: number, p: Partial<AddressEntry>) => set(list.map((a, k) => (k === i ? { ...a, ...p } : a)));

  const lookup = async (i: number) => {
    const entry = list[i];
    if (!geocode || !entry) return;
    if (!entry.address.trim()) {
      setMsg({ at: i, text: 'Enter the address first.' });
      return;
    }
    setBusy(i);
    setMsg(null);
    try {
      const hit = await geocode.run(entry.address.trim());
      if (!hit) setMsg({ at: i, text: 'No coordinates found for that address. Check the street and town, or enter them manually.' });
      else {
        patch(i, { latitude: String(hit.latitude), longitude: String(hit.longitude) });
        setMsg({ at: i, text: hit.approximate ? `Approximate (area only): ${hit.label ?? ''}` : `Matched ${hit.label ?? `${hit.latitude}, ${hit.longitude}`}` });
      }
    } catch {
      setMsg({ at: i, text: 'Lookup failed. Enter the coordinates manually.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={s.list}>
      {list.length === 0 && (
        <Text size={200} className={s.muted}>
          None. Add one for each other building on this site that has its own address; each appears on the map under this site's code.
        </Text>
      )}
      {list.map((a, i) => (
        <div key={i} className={s.entry}>
          <div className={s.head}>
            <Input aria-label="Label" placeholder="Label, e.g. Building B" value={a.label} onChange={(_, d) => patch(i, { label: d.value })} style={{ flex: 1 }} />
            <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label="Remove this address" onClick={() => set(list.filter((_, k) => k !== i))} />
          </div>
          <Textarea aria-label="Address" placeholder="Civic address" resize="vertical" value={a.address} onChange={(_, d) => patch(i, { address: d.value })} />
          <div className={s.coords}>
            {(['latitude', 'longitude'] as const).map((k) => (
              <Input
                key={k}
                aria-label={k === 'latitude' ? 'Latitude' : 'Longitude'}
                placeholder={k === 'latitude' ? 'Latitude' : 'Longitude'}
                inputMode="decimal"
                value={a[k]}
                onPaste={(e) => {
                  const pair = parseCoordinatePair(e.clipboardData.getData('text'));
                  if (!pair) return;
                  e.preventDefault();
                  patch(i, pair);
                }}
                onChange={(_, d) => isCoordinateText(d.value) && patch(i, { [k]: d.value })}
              />
            ))}
          </div>
          <div className={s.actions}>
            {geocode && (
              <Button size="small" appearance="secondary" disabled={busy === i} onClick={() => void lookup(i)}>
                {busy === i ? <Spinner size="tiny" /> : 'Get coordinates from address'}
              </Button>
            )}
            {msg?.at === i && (
              <Text size={200} className={s.muted}>
                {msg.text}
              </Text>
            )}
          </div>
        </div>
      ))}
      <div>
        <Button size="small" icon={<AddRegular />} onClick={() => set([...list, emptyAddress()])}>
          Add another address
        </Button>
      </div>
    </div>
  );
}
