import { z } from 'zod';
import { SITE_REGIONS, type SiteRegion } from './domain';

/*
 * Device status (docs/DEVICE-MONITORING.md): reads an Uptime Kuma status page and turns it into one row per monitor.
 * Kuma's status page JSON is not a supported contract, so everything here is tolerant of missing fields and is tested against
 * recorded samples (device-status.test.ts). Voxshift only ever reads Kuma; engineers create and tag the monitors there.
 */

export const DEVICE_KINDS = ['algo', 'poly', 'dect', 'audiocodes', 'teams-room', 'other'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  algo: 'Algo paging',
  poly: 'Poly',
  dect: 'DECT',
  audiocodes: 'AudioCodes',
  'teams-room': 'Teams Room',
  other: 'Other',
};

export const DEVICE_STATES = ['up', 'down', 'pending', 'maintenance', 'unknown'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

/** Worst first: how a site's tile colour is chosen. */
const SEVERITY: Record<DeviceState, number> = { down: 4, pending: 3, unknown: 2, maintenance: 1, up: 0 };

export interface DeviceMonitor {
  kumaId: number;
  name: string;
  monitorType: string;
  group: string | null;
  sitecode: string | null;
  deviceKind: DeviceKind;
  state: DeviceState;
  /** When it entered this state, from Kuma's last 100 beats. */
  since: string | null;
  /** False when the whole window is in this one state, so it has been that way at least since `since`. */
  sinceExact: boolean;
  lastBeatAt: string | null;
  responseMs: number | null;
  message: string;
  uptime24h: number | null;
}

const tagSchema = z.object({ name: z.string().optional(), value: z.string().nullish() }).passthrough();
const monitorSchema = z
  .object({ id: z.number().int(), name: z.string().default(''), type: z.string().default(''), tags: z.array(tagSchema).default([]) })
  .passthrough();
const statusPageSchema = z
  .object({ publicGroupList: z.array(z.object({ name: z.string().default(''), monitorList: z.array(monitorSchema).default([]) }).passthrough()).default([]) })
  .passthrough();
const beatSchema = z.object({ status: z.number().int(), time: z.string(), msg: z.string().nullish(), ping: z.number().nullish() }).passthrough();
const heartbeatSchema = z
  .object({ heartbeatList: z.record(z.string(), z.array(beatSchema)).default({}), uptimeList: z.record(z.string(), z.number()).default({}) })
  .passthrough();

const STATE_OF: Record<number, DeviceState> = { 1: 'up', 0: 'down', 2: 'pending', 3: 'maintenance' };

/** Kuma writes "2026-10-27 06:25:48.595", in UTC, with no zone. */
export function kumaTime(t: string): string | null {
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const clean = (v: string) => v.trim().slice(0, 64);

/** A monitor's tags: `site` / `device` as name + value (Kuma's tag form), or `site=LTN01` written as one tag name. */
export function readDeviceTags(tags: Array<{ name?: string; value?: string | null }>): { sitecode: string | null; deviceKind: DeviceKind } {
  let sitecode: string | null = null;
  let kind: DeviceKind = 'other';
  for (const t of tags) {
    let name = (t.name ?? '').trim();
    let value = (t.value ?? '').trim();
    const eq = name.match(/^(site|device)\s*[=:]\s*(.+)$/i);
    if (eq) { name = eq[1]!; value = eq[2]!.trim(); }
    name = name.toLowerCase();
    if (name === 'site' && value) sitecode = clean(value);
    if (name === 'device' && value) {
      const k = value.toLowerCase().replace(/[\s_]+/g, '-');
      kind = (DEVICE_KINDS as readonly string[]).includes(k) ? (k as DeviceKind) : 'other';
    }
  }
  return { sitecode, deviceKind: kind };
}

/** Joins the two status page documents into one entry per monitor. Throws a plain message when either is not a Kuma status page. */
export function parseKumaStatus(page: unknown, heartbeats: unknown): DeviceMonitor[] {
  const p = statusPageSchema.safeParse(page);
  const h = heartbeatSchema.safeParse(heartbeats);
  if (!p.success || !h.success || !(page as { publicGroupList?: unknown })?.publicGroupList) {
    throw new Error('That does not look like a monitoring status page (no device list). Check the address and the status page name.');
  }
  const out: DeviceMonitor[] = [];
  for (const group of p.data.publicGroupList) {
    for (const m of group.monitorList) {
      const beats = (h.data.heartbeatList[String(m.id)] ?? []).slice().sort((a, b) => (kumaTime(a.time) ?? '').localeCompare(kumaTime(b.time) ?? ''));
      const last = beats[beats.length - 1];
      const state: DeviceState = last ? (STATE_OF[last.status] ?? 'unknown') : 'unknown';
      let sinceBeat = last;
      let exact = false;
      for (let i = beats.length - 1; i >= 0; i--) {
        if ((STATE_OF[beats[i]!.status] ?? 'unknown') === state) sinceBeat = beats[i];
        else { exact = true; break; }
      }
      const { sitecode, deviceKind } = readDeviceTags(m.tags);
      out.push({
        kumaId: m.id,
        name: m.name,
        monitorType: m.type,
        group: group.name || null,
        sitecode,
        deviceKind,
        state,
        since: sinceBeat ? kumaTime(sinceBeat.time) : null,
        sinceExact: exact,
        lastBeatAt: last ? kumaTime(last.time) : null,
        responseMs: last?.ping ?? null,
        message: (last?.msg ?? '').slice(0, 300),
        uptime24h: h.data.uptimeList[`${m.id}_24`] ?? null,
      });
    }
  }
  return out;
}

/** The monitors that are shown to people: only tags decide the site; no tag = "Not assigned to a site". */
export interface SiteDeviceSummary {
  sitecode: string | null;
  state: DeviceState;
  counts: Record<DeviceState, number>;
  total: number;
}

export function summariseBySite(monitors: Array<Pick<DeviceMonitor, 'sitecode' | 'state'>>): SiteDeviceSummary[] {
  const bySite = new Map<string, SiteDeviceSummary>();
  for (const m of monitors) {
    const key = m.sitecode ?? '';
    let s = bySite.get(key);
    if (!s) { s = { sitecode: m.sitecode, state: m.state, counts: { up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0 }, total: 0 }; bySite.set(key, s); }
    s.counts[m.state]++;
    s.total++;
    if (SEVERITY[m.state] > SEVERITY[s.state]) s.state = m.state;
  }
  // Worst sites first, then by code; the unassigned bucket last.
  return [...bySite.values()].sort((a, b) => {
    if ((a.sitecode === null) !== (b.sitecode === null)) return a.sitecode === null ? 1 : -1;
    return SEVERITY[b.state] - SEVERITY[a.state] || (a.sitecode ?? '').localeCompare(b.sitecode ?? '');
  });
}

/** A site's tile on the status screen: its devices' state, plus where the site is so the tiles can be grouped. */
export interface SiteTile extends SiteDeviceSummary {
  name: string | null;
  /** The site exists in Voxshift (its tag matched a site code). */
  known: boolean;
  country: string | null;
  region: SiteRegion | null;
}

export const SITE_REGION_LABEL: Record<SiteRegion, string> = { AMER: 'Americas (AMER)', EMEA: 'Europe, Middle East & Africa (EMEA)', APAC: 'Asia Pacific (APAC)' };

export interface SiteTileCountry {
  /** '' = the sites have no country. */
  country: string;
  tiles: SiteTile[];
  state: DeviceState;
  down: number;
}
export interface SiteTileRegion {
  /** '' = the sites have no region. */
  region: SiteRegion | '';
  countries: SiteTileCountry[];
  state: DeviceState;
  down: number;
  siteCount: number;
}

const worst = (states: DeviceState[]): DeviceState => states.reduce<DeviceState>((w, x) => (SEVERITY[x] > SEVERITY[w] ? x : w), 'up');

/**
 * Groups the site tiles by region (AMER, EMEA, APAC, then sites with no region) and, inside a region, by country (A to Z, no country last). The worst
 * tiles come first inside a country, and each region and country carries the worst state and the number of devices down so a problem shows without opening
 * anything. Tiles that are not a site (monitors with no site tag) are returned apart.
 */
export function groupSiteTiles(tiles: SiteTile[]): { regions: SiteTileRegion[]; unassigned: SiteTile[] } {
  const sitesOnly = tiles.filter((t) => t.sitecode !== null);
  const unassigned = tiles.filter((t) => t.sitecode === null);
  const order = (r: SiteRegion | '') => (r === '' ? SITE_REGIONS.length : SITE_REGIONS.indexOf(r));
  const byRegion = new Map<SiteRegion | '', Map<string, SiteTile[]>>();
  const spelling = new Map<string, string>();
  for (const t of sitesOnly) {
    const region = t.region ?? '';
    const typed = (t.country ?? '').trim();
    const key = typed.toLowerCase();
    if (typed && !spelling.has(key)) spelling.set(key, typed);
    const countries = byRegion.get(region) ?? new Map<string, SiteTile[]>();
    countries.set(key, [...(countries.get(key) ?? []), t]);
    byRegion.set(region, countries);
  }
  const regions: SiteTileRegion[] = [...byRegion.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([region, countries]) => {
      const list: SiteTileCountry[] = [...countries.entries()]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([key, ts]) => ({
          country: key === '' ? '' : (spelling.get(key) ?? key),
          tiles: [...ts].sort((x, y) => SEVERITY[y.state] - SEVERITY[x.state] || (x.sitecode ?? '').localeCompare(y.sitecode ?? '')),
          state: worst(ts.map((x) => x.state)),
          down: ts.reduce((n, x) => n + x.counts.down, 0),
        }));
      return { region, countries: list, state: worst(list.map((c) => c.state)), down: list.reduce((n, c) => n + c.down, 0), siteCount: list.reduce((n, c) => n + c.tiles.length, 0) };
    });
  return { regions, unassigned };
}

/** How old a poll may be before the tiles say the status is stale rather than showing old colours as current. */
export const DEVICE_STATUS_STALE_SECONDS = 120;

/** The address part of a Kuma status page: letters, digits, dashes and underscores (what Kuma allows). */
export const kumaSlugSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use the status page name: letters, digits, - and _ only.');

export const deviceMonitorSettingsSchema = z.object({
  enabled: z.boolean(),
  kumaUrl: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v.replace(/\/+$/, ''))
    .pipe(z.string().refine((v) => v === '' || /^https?:\/\/[^\s/?#]+$/i.test(v), 'Use the address of the monitoring service only, like http://host:3001 (no path).')),
  statusSlug: z.union([kumaSlugSchema, z.literal('')]),
});
export type DeviceMonitorSettingsInput = z.infer<typeof deviceMonitorSettingsSchema>;

/** What the Device status tab shows (GET /t/:tenantId/device-status). */
export interface DeviceMonitorSettingsView {
  enabled: boolean;
  kumaUrl: string;
  statusSlug: string;
  lastPolledAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface DeviceRow {
  kumaId: number;
  name: string;
  group: string | null;
  sitecode: string | null;
  deviceKind: DeviceKind;
  state: DeviceState;
  since: string;
  sinceExact: boolean;
  lastBeatAt: string | null;
  responseMs: number | null;
  message: string;
  uptime24h: number | null;
  monitorType: string;
}
export interface DeviceChangeRow {
  id: string;
  name: string;
  sitecode: string | null;
  deviceKind: DeviceKind;
  from: DeviceState | null;
  to: DeviceState;
  at: string;
  message: string;
}
export interface DeviceStatusOverview {
  settings: DeviceMonitorSettingsView;
  /** Phase 2: Voxshift looks after Kuma (see device-inventory.ts). */
  managed: import('./device-inventory').DeviceManagedView;
  inventory: import('./device-inventory').DeviceInventoryRow[];
  /** The customer's sites, for the Add device form. */
  siteOptions: Array<{ sitecode: string; name: string | null }>;
  /** Enabled, but the last good read is older than DEVICE_STATUS_STALE_SECONDS (or there has been none): colours below are old. */
  stale: boolean;
  devices: DeviceRow[];
  sites: SiteTile[];
  changes: DeviceChangeRow[];
}

