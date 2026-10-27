import { z } from 'zod';
import { DEVICE_KINDS, type DeviceKind } from './device-status';

/*
 * Device inventory (docs/DEVICE-MONITORING.md, phase 2): the devices a customer wants watched, kept in Voxshift. Voxshift keeps Uptime Kuma in
 * step with this list (packages/db/src/device-sync.ts), so nobody has to open Kuma: a device here becomes a Kuma monitor tagged site= and
 * device=, on the status page Voxshift reads. Only what Voxshift writes to Kuma is described here; reading is device-status.ts.
 */

export const DEVICE_CHECK_TYPES = ['ping', 'port'] as const;
export type DeviceCheckType = (typeof DEVICE_CHECK_TYPES)[number];
export const DEVICE_CHECK_LABEL: Record<DeviceCheckType, string> = { ping: 'Ping', port: 'TCP port' };

/** Kuma's shortest interval is 20 seconds; this is what a device is checked at. */
export const DEVICE_CHECK_INTERVAL_SECONDS = 20;

/** A host name or IP address (v4, or v6 without brackets): not a URL, no spaces, no path. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|[0-9A-Fa-f:]+:[0-9A-Fa-f:.]*)$/;

export const deviceInventoryInputSchema = z
  .object({
    siteCode: z.string().trim().min(1, 'Choose the site.').max(64),
    name: z.string().trim().min(1, 'Give the device a name.').max(120),
    kind: z.enum(DEVICE_KINDS),
    checkType: z.enum(DEVICE_CHECK_TYPES),
    address: z.string().trim().max(253).regex(HOST, 'Use the device\'s IP address or host name, with no http:// and no path.'),
    port: z.number().int().min(1).max(65535).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.checkType === 'port' && !v.port) ctx.addIssue({ code: 'custom', path: ['port'], message: 'Enter the port to check.' });
  })
  .transform((v) => ({ ...v, port: v.checkType === 'port' ? (v.port ?? null) : null }));
export type DeviceInventoryInput = z.infer<typeof deviceInventoryInputSchema>;

export type DeviceSyncState = 'pending' | 'synced' | 'error';

export interface DeviceInventoryRow {
  id: string;
  siteCode: string;
  name: string;
  kind: DeviceKind;
  checkType: DeviceCheckType;
  address: string;
  port: number | null;
  syncState: DeviceSyncState;
  syncError: string | null;
}

/** The "managed" half of the settings: whether Voxshift runs Kuma for the customer, and where it is up to. */
export interface DeviceManagedView {
  managed: boolean;
  /** Voxshift knows the Kuma administrator's sign-in (it made it, or it was entered). */
  hasCredentials: boolean;
  syncNeeded: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

/** What Voxshift is asked to set up automatically (POST device-status/auto-setup). Everything is optional: the defaults suit the compose stack. */
export const deviceAutoSetupSchema = z.object({
  kumaUrl: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v.replace(/\/+$/, ''))
    .pipe(z.string().refine((v) => v === '' || /^https?:\/\/[^\s/?#]+$/i.test(v), 'Use the address of the monitoring service only, like http://host:3001 (no path).'))
    .optional(),
  /** Only when Kuma already has an administrator that Voxshift did not create. */
  adminUser: z.string().trim().max(120).optional(),
  adminPassword: z.string().max(200).optional(),
});
export type DeviceAutoSetupInput = z.infer<typeof deviceAutoSetupSchema>;

export const KUMA_DEFAULT_URL = 'http://kuma:3001';
/**
 * Each customer's managed status page has its own address, made from the customer's id, so customers sharing one monitoring service never share a page
 * (what one customer's dashboard reads is only that customer's devices). Letters, digits and dashes only, as the service wants.
 */
export function kumaSlugForTenant(tenantId: string): string {
  return `voxshift-${tenantId.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, 12)}`;
}
/** True for an address Voxshift made for some customer (so one customer can be stopped from reading another's). */
export const isTenantStatusSlug = (slug: string) => /^voxshift-[0-9a-f]{12}$/.test(slug);
/** The one shared page earlier releases made for every customer; customers still on it move to their own on the next sync. */
export const KUMA_LEGACY_SLUG = 'voxshift';
export const KUMA_MANAGED_TITLE = 'Voxshift Device Status';

// ---------------------------------------------------------------------------------------------------------------- the Kuma side

/** What the frontend of Uptime Kuma 2.5.7 sends for a new monitor (src/pages/EditMonitor.vue, monitorDefaults), as checked against a real Kuma. */
const KUMA_MONITOR_DEFAULTS = {
  type: 'http',
  name: '',
  parent: null,
  url: 'https://',
  wsSubprotocol: '',
  method: 'GET',
  protocol: null,
  location: 'world',
  ipFamily: null,
  interval: 60,
  retryInterval: 60,
  resendInterval: 0,
  maxretries: 0,
  retryOnlyOnStatusCodeFailure: false,
  notificationIDList: {},
  ignoreTls: false,
  upsideDown: false,
  expiryNotification: false,
  domainExpiryNotification: false,
  maxredirects: 10,
  accepted_statuscodes: ['200-299'],
  saveResponse: false,
  saveErrorResponse: true,
  responseMaxLength: 1024,
  dns_resolve_type: 'A',
  dns_resolve_server: '',
  docker_container: '',
  docker_host: null,
  proxyId: null,
  basic_auth_user: '',
  basic_auth_pass: '',
  bearer_token: '',
  mqttUsername: '',
  mqttPassword: '',
  mqttTopic: '',
  mqttWebsocketPath: '',
  mqttSuccessMessage: '',
  mqttCheckType: 'keyword',
  authMethod: null,
  oauth_auth_method: 'client_secret_basic',
  httpBodyEncoding: 'json',
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: 'None' },
  cacheBust: false,
  kafkaProducerSsl: false,
  kafkaProducerAllowAutoTopicCreation: false,
  gamedigGivenPortOnly: true,
  gamedigToken: '',
  remote_browser: null,
  screenshot_delay: 0,
  rabbitmqNodes: [],
  rabbitmqUsername: '',
  rabbitmqPassword: '',
  conditions: [],
  system_service_name: '',
  sshAuthMethod: 'password',
  ntpStratumThreshold: 5,
  ntpTimeOffsetThreshold: 1000,
  ntpRootDispersionThreshold: 500,
} as const;

type Device = Pick<DeviceInventoryRow, 'name' | 'checkType' | 'address' | 'port'>;

/** The fields of a Kuma monitor that Voxshift decides. Everything else is left as Kuma has it. */
export function kumaMonitorFields(d: Device): Record<string, unknown> {
  const common = { name: d.name, interval: DEVICE_CHECK_INTERVAL_SECONDS, retryInterval: DEVICE_CHECK_INTERVAL_SECONDS, maxretries: 1, timeout: 10 };
  if (d.checkType === 'ping') {
    return { ...common, type: 'ping', hostname: d.address, port: null, packetSize: 56, ping_count: 1, ping_numeric: true, ping_per_request_timeout: 2 };
  }
  return { ...common, type: 'port', hostname: d.address, port: d.port };
}

/** The payload for Kuma's `add` event. */
export function kumaNewMonitor(d: Device): Record<string, unknown> {
  const m: Record<string, unknown> = { ...KUMA_MONITOR_DEFAULTS, ...kumaMonitorFields(d) };
  delete m.url; // a ping or port monitor has no URL
  return m;
}

/** The two tags Voxshift reads back: site=<site code>, device=<kind>. */
export function kumaTagsFor(d: Pick<DeviceInventoryRow, 'siteCode' | 'kind'>): Array<{ name: 'site' | 'device'; value: string }> {
  return [
    { name: 'site', value: d.siteCode },
    { name: 'device', value: d.kind },
  ];
}

/** Which tag rows to add and which to delete so a monitor ends up with exactly the wanted site and device tags (other tags are left alone). */
export function planTagChanges(
  wanted: Array<{ name: string; value: string }>,
  current: Array<{ tag_id?: number; id?: number; name?: string; value?: string | null }>,
): { remove: Array<{ tagId: number; value: string }>; add: Array<{ name: string; value: string }> } {
  const ours = new Set(['site', 'device']);
  const remove: Array<{ tagId: number; value: string }> = [];
  const keep = new Set<string>();
  for (const t of current) {
    if (!t.name || !ours.has(t.name)) continue;
    const key = `${t.name}\u0000${t.value ?? ''}`;
    const isWanted = wanted.some((w) => w.name === t.name && w.value === (t.value ?? ''));
    if (isWanted && !keep.has(key)) keep.add(key);
    else if (typeof t.tag_id === 'number') remove.push({ tagId: t.tag_id, value: t.value ?? '' });
  }
  const add = wanted.filter((w) => !keep.has(`${w.name}\u0000${w.value}`));
  return { remove, add };
}
