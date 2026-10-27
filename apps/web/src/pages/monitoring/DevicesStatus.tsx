import { Card, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, mergeClasses } from '@fluentui/react-components';
import { Link } from 'react-router';
import { DEVICE_KIND_LABEL, SITE_REGION_LABEL, groupSiteTiles, type SiteTile } from '@tvmf/shared';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { EmptyState } from '../../components/states';
import { DangerText, MutedText } from '../../components/ui';
import { StateBadge, STATE, ago, isConfigured, useOverview, useStyles, useTick } from './common';

function Tile({ t }: { t: SiteTile }) {
  const s = useStyles();
  return (
    <Card className={mergeClasses(s.tile, s[t.state])}>
      <div className={s.tileTop}>
        <Text weight="semibold">{t.sitecode ?? 'No site tag'}</Text>
        <StateBadge state={t.state} />
      </div>
      <MutedText size={200}>{t.sitecode ? (t.name ?? (t.known ? '' : 'Not a site in Voxshift')) : 'Monitors with no site tag'}</MutedText>
      <Text size={200}>
        {t.total} device{t.total === 1 ? '' : 's'}
        {t.counts.down > 0 && <DangerText size={200}> · {t.counts.down} down</DangerText>}
        {t.counts.pending > 0 && ` · ${t.counts.pending} checking`}
        {t.counts.maintenance > 0 && ` · ${t.counts.maintenance} in maintenance`}
      </Text>
    </Card>
  );
}

/** "3 sites · 1 device down", for a region or country heading, so a problem shows without opening anything. */
function Rollup({ sites, down }: { sites: number; down: number }) {
  return (
    <MutedText size={200}>
      {sites} site{sites === 1 ? '' : 's'}
      {down > 0 && <DangerText size={200}> · {down} device{down === 1 ? '' : 's'} down</DangerText>}
    </MutedText>
  );
}

/**
 * The site tiles, grouped by region (AMER, EMEA, APAC) and, inside each, by country. A customer whose sites have neither gets the plain grid, as before;
 * a customer with only countries (or only regions) gets just that level.
 */
function SiteTiles({ tiles }: { tiles: SiteTile[] }) {
  const s = useStyles();
  const { regions, unassigned } = groupSiteTiles(tiles);
  const showRegion = regions.some((r) => r.region !== '');
  const showCountry = regions.some((r) => r.countries.some((c) => c.country !== ''));
  if (!showRegion && !showCountry) {
    return (
      <div className={s.tiles}>
        {[...regions.flatMap((r) => r.countries.flatMap((c) => c.tiles)), ...unassigned].map((t) => (
          <Tile key={t.sitecode ?? '—'} t={t} />
        ))}
      </div>
    );
  }
  return (
    <>
      {regions.map((r) => (
        <section key={r.region || 'none'} className={s.region}>
          {showRegion && (
            <div className={s.regionHead}>
              <Text weight="semibold" size={400}>
                {r.region ? SITE_REGION_LABEL[r.region] : 'No region set'}
              </Text>
              <StateBadge state={r.state} />
              <Rollup sites={r.siteCount} down={r.down} />
            </div>
          )}
          {r.countries.map((c) => (
            <div key={c.country || 'none'} className={s.section}>
              {showCountry && (
                <div className={s.countryHead}>
                  <Text weight="semibold">{c.country || 'No country set'}</Text>
                  <Rollup sites={c.tiles.length} down={c.down} />
                </div>
              )}
              <div className={s.tiles}>
                {c.tiles.map((t) => (
                  <Tile key={t.sitecode ?? '—'} t={t} />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
      {unassigned.length > 0 && (
        <section className={s.region}>
          <div className={s.regionHead}>
            <Text weight="semibold" size={400}>
              Not assigned to a site
            </Text>
          </div>
          <div className={s.tiles}>
            {unassigned.map((t) => (
              <Tile key="none" t={t} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Monitoring > Devices: the status screen. Read only, and the only Monitoring screen project managers and customers get: tiles by site, what is down
 * now, every device and the latest changes. Adding devices, the watch list, setup and alerts are separate screens for engineers and administrators.
 */
export function DevicesStatus({ base, canManage }: { base: string; canManage: boolean }) {
  const s = useStyles();
  const q = useOverview(base);
  useTick();

  if (q.isLoading) return <Spinner size="tiny" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  const data = q.data!;
  const now = Date.now();
  const down = data.devices.filter((d) => d.state === 'down').sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  // A viewer cannot tell whether monitoring is "set up" from the settings we hide from them: no devices and nothing ever read means nothing to show yet.
  const neverRead = !data.settings.lastOkAt && data.devices.length === 0;

  if (neverRead && !data.settings.enabled && !isConfigured(data)) {
    return (
      <EmptyState
        title="Monitoring is not set up yet"
        hint={
          canManage
            ? 'Set it up and add the devices to watch under Watch list in the Monitoring menu.'
            : 'Monitoring has not been set up for this customer yet. An engineer will add the devices.'
        }
        action={canManage ? <Link to="/monitoring/watch-list">Go to the watch list</Link> : undefined}
      />
    );
  }

  return (
    <div className={s.page}>
      <div className={s.head}>
        <MutedText size={200}>
          {!data.settings.enabled ? 'Switched off.' : data.settings.lastOkAt ? `Last read ${ago(data.settings.lastOkAt, now)} ago.` : 'Waiting for the first read.'}
        </MutedText>
      </div>

      {data.settings.enabled && data.settings.lastError && (
        <Card className={s.banner}>
          <DangerText weight="semibold">Voxshift cannot read the monitoring status.</DangerText>
          <Text size={200}>{data.settings.lastError}</Text>
        </Card>
      )}
      {data.stale && !data.settings.lastError && data.settings.lastOkAt && (
        <Card className={s.banner}>
          <Text weight="semibold">The colours below are from {ago(data.settings.lastOkAt, now)} ago.</Text>
        </Card>
      )}

      {data.devices.length === 0 ? (
        data.settings.enabled && !data.settings.lastError && data.settings.lastOkAt ? (
          <EmptyState title="No devices are being watched yet" hint={canManage ? 'Add them under Watch list in the Monitoring menu.' : 'An engineer will add the devices.'} />
        ) : null
      ) : (
        <>
        <SiteTiles tiles={data.sites} />

        {down.length > 0 && (
          <div className={s.section}>
            <Text weight="semibold">Down now</Text>
            <DataTable size="small" minWidth={560}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Device</TableHeaderCell>
                  <TableHeaderCell>Site</TableHeaderCell>
                  <TableHeaderCell>Down for</TableHeaderCell>
                  <TableHeaderCell>What the check says</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {down.map((d) => (
                  <TableRow key={d.kumaId}>
                    <TableCell>{d.name}</TableCell>
                    <TableCell>{d.sitecode ?? '—'}</TableCell>
                    <TableCell>
                      {d.sinceExact ? '' : 'at least '}
                      {ago(d.since, now)}
                    </TableCell>
                    <TableCell>{d.message || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </div>
        )}

        <div className={s.section}>
          <Text weight="semibold">All devices</Text>
          <DataTable size="small" minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Device</TableHeaderCell>
                <TableHeaderCell>Site</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>For</TableHeaderCell>
                <TableHeaderCell>Response</TableHeaderCell>
                <TableHeaderCell>Up, last 24 h</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.devices.map((d) => (
                <TableRow key={d.kumaId}>
                  <TableCell>{d.name}</TableCell>
                  <TableCell>{d.sitecode ?? '—'}</TableCell>
                  <TableCell>{DEVICE_KIND_LABEL[d.deviceKind]}</TableCell>
                  <TableCell>
                    <StateBadge state={d.state} />
                  </TableCell>
                  <TableCell>
                    {d.sinceExact ? '' : 'at least '}
                    {ago(d.since, now)}
                  </TableCell>
                  <TableCell>{d.responseMs === null ? '—' : `${d.responseMs < 10 ? d.responseMs.toFixed(1) : Math.round(d.responseMs)} ms`}</TableCell>
                  <TableCell>{d.uptime24h === null ? '—' : `${(d.uptime24h * 100).toFixed(d.uptime24h === 1 ? 0 : 1)}%`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        </div>

        <div className={s.section}>
          <Text weight="semibold">Recent changes</Text>
          {data.changes.length === 0 ? (
            <MutedText size={200}>No changes seen yet. Voxshift keeps them for 90 days.</MutedText>
          ) : (
            <DataTable size="small" minWidth={620}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Device</TableHeaderCell>
                  <TableHeaderCell>Site</TableHeaderCell>
                  <TableHeaderCell>Change</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.changes.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{new Date(c.at).toLocaleString()}</TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell>{c.sitecode ?? '—'}</TableCell>
                    <TableCell>
                      {c.from ? `${STATE[c.from].label} → ` : 'First seen '}
                      <StateBadge state={c.to} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          )}
        </div>

        </>
      )}
    </div>
  );
}
