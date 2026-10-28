import { useEffect } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { Button, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';

const useLocalStyles = makeStyles({
  w100H100: { height: "100%", width: "100%" },
});


// Vite serves these as hashed asset URLs; wire them into Leaflet's default icon
// so markers render without the library's broken relative paths.
L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });

export interface MapSite {
  id: string;
  sitecode: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  /** other buildings on the site; each is pinned under the same site code */
  additionalAddresses?: { id: string; label: string | null; address: string; latitude: number | null; longitude: number | null }[];
  counts?: { users: number; numbers: number; numbersAssigned: number };
}

const useStyles = makeStyles({
  wrap: {
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.overflow('hidden'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    height: '440px',
  },
  popup: { display: 'grid', ...shorthands.gap('4px'), minWidth: '180px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** Pan/zoom to fit every placed site whenever the set changes. */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 12);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

export function SitesMap({
  sites,
  onOpen,
}: {
  sites: MapSite[];
  onOpen: (siteId: string) => void;
}) {
  const ls = useLocalStyles();
  const s = useStyles();
  // One pin per address: the site's own, then each additional address - all under the site's code.
  const pins = sites.flatMap((site) => [
    { key: site.id, site, lat: site.latitude, lon: site.longitude, label: null as string | null, address: null as string | null },
    ...(site.additionalAddresses ?? []).map((a) => ({ key: `${site.id}:${a.id}`, site, lat: a.latitude, lon: a.longitude, label: a.label || 'Additional address', address: a.address })),
  ]);
  const placed = pins.filter((x) => typeof x.lat === 'number' && typeof x.lon === 'number');
  const points = placed.map((x) => [x.lat as number, x.lon as number] as [number, number]);

  return (
    <div className={s.wrap}>
      <MapContainer
        center={points[0] ?? [39.5, -98.35]}
        zoom={points.length ? 6 : 3}
        className={ls.w100H100}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        {placed.map(({ key, site, lat, lon, label, address }) => (
          <Marker key={key} position={[lat as number, lon as number]}>
            <Popup>
              <div className={s.popup}>
                <Text weight="semibold">{site.name || site.sitecode}</Text>
                <Text size={200} className={s.muted}>
                  {site.sitecode}
                  {label ? ` · ${label}` : ''}
                  {!label && site.counts
                    ? ` · ${site.counts.users} users · ${site.counts.numbersAssigned}/${site.counts.numbers} numbers`
                    : ''}
                </Text>
                {address && (
                  <Text size={200} className={s.muted}>
                    {address}
                  </Text>
                )}
                <Button size="small" appearance="primary" onClick={() => onOpen(site.id)}>
                  Open site
                </Button>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
