import { z } from 'zod';
import { DEVICE_KINDS, type DeviceKind } from './device-status';

/*
 * Device inventory (docs/DEVICE-MONITORING.md, phase 2): the devices a customer wants watched, kept in Voxshift. Voxshift keeps Uptime Kuma in
 * step with this list (packages/db/src/device-sync.ts), so nobody has to open Kuma: a device here becomes a Kuma monitor tagged site= and
 * device=, on the status page Voxshift reads. Only what Voxshift writes to Kuma is described here; reading is device-status.ts.
 */

export const DEVICE_CHECK_TYPES = ['ping', 'port', 'snmp'] as const;
export type DeviceCheckType = (typeof DEVICE_CHECK_TYPES)[number];
export const DEVICE_CHECK_LABEL: Record<DeviceCheckType, string> = { ping: 'Ping', port: 'TCP port', snmp: 'SNMP' };

// ------------------------------------------------------------------------------------------------------------------ SNMP checks
// What Uptime Kuma 2.5.7's SNMP monitor asks for (server/monitor-types/snmp.js): one OID is read from the device with a GET, and the value is compared with an
// expected one. Kuma supports SNMP v1, v2c and v3 with no authentication (noAuthNoPriv: a user name only).

export const SNMP_VERSIONS = ['1', '2c', '3'] as const;
export type SnmpVersion = (typeof SNMP_VERSIONS)[number];
export const SNMP_VERSION_LABEL: Record<SnmpVersion, string> = { '1': 'SNMPv1', '2c': 'SNMPv2c', '3': 'SNMPv3 (user name only)' };
export const SNMP_DEFAULT_PORT = 161;

/** The comparisons Kuma offers. */
export const SNMP_OPERATORS = ['==', '!=', '>', '>=', '<', '<=', 'contains'] as const;
export type SnmpOperator = (typeof SNMP_OPERATORS)[number];
export const SNMP_OPERATOR_LABEL: Record<SnmpOperator, string> = { '==': 'equals', '!=': 'is not', '>': 'is more than', '>=': 'is at least', '<': 'is less than', '<=': 'is at most', contains: 'contains' };

/** The pattern Kuma's own form insists on: dotted numbers, first 0-2, no leading zeros after it (a trailing .0 is fine). */
export const SNMP_OID = /^([0-2])((\.0)|(\.[1-9][0-9]*))*$/;

export interface SnmpPreset { id: string; label: string; hint: string; oid: string; operator: SnmpOperator; expected: string }
/** Ready-made readings so nobody has to look an OID up. A person can change any of the three after choosing one. */
export const SNMP_PRESETS: SnmpPreset[] = [
  { id: 'answers', label: 'Answers SNMP (system uptime)', hint: 'Reads sysUpTime, which every SNMP device has: the check passes while the device answers.', oid: '1.3.6.1.2.1.1.3.0', operator: '>=', expected: '0' },
  { id: 'interface', label: 'Network port is up (ifOperStatus)', hint: 'Passes while the port is up. The last number is the port\'s interface number: change it for another port.', oid: '1.3.6.1.2.1.2.2.1.8.1', operator: '==', expected: '1' },
  { id: 'trunk-dsx1', label: 'E1/T1 trunk has no alarm (gateways)', hint: 'The standard DS1 line status (RFC 2495), which AudioCodes gateways with E1/T1 trunks support: 1 means no alarm. The last number is the trunk\'s line index (usually 1 for the first trunk): change it for another trunk.', oid: '1.3.6.1.2.1.10.18.6.1.10.1', operator: '==', expected: '1' },
  { id: 'algo-sip-reg', label: 'Algo: SIP registration', hint: 'The Algo sipReg value, which reads like "Page, Successful, ..." while the device is registered with the phone system.', oid: '1.3.6.1.4.1.41738.1.1.2.1.1.0', operator: 'contains', expected: 'Successful' },
  { id: 'algo-idle', label: 'Algo: not stuck in a call', hint: 'The Algo sipCall value, which reads "Idle" when no call is in progress.', oid: '1.3.6.1.4.1.41738.1.1.2.1.2.0', operator: '==', expected: 'Idle' },
  { id: 'algo-door-relay', label: 'Algo 8028: door relay closed', hint: 'The ioDoorRelayState of the Algo 8028 only (other models do not have it): 0 is closed, 1 is open.', oid: '1.3.6.1.4.1.41738.1.1.2.3.1.0', operator: '==', expected: '0' },
];

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
    /** SNMP checks only. */
    snmpVersion: z.enum(SNMP_VERSIONS).nullish(),
    /** v1 and v2c. Blank on a change means "keep the one stored"; it is never sent back to a browser. */
    snmpCommunity: z.string().max(200).nullish(),
    /** v3. */
    snmpUsername: z.string().trim().max(120).nullish(),
    snmpOid: z.string().trim().max(200).nullish(),
    snmpOperator: z.enum(SNMP_OPERATORS).nullish(),
    snmpExpected: z.string().trim().max(200).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.checkType === 'port' && !v.port) ctx.addIssue({ code: 'custom', path: ['port'], message: 'Enter the port to check.' });
    if (v.checkType !== 'snmp') return;
    if (!v.snmpVersion) ctx.addIssue({ code: 'custom', path: ['snmpVersion'], message: 'Choose the SNMP version.' });
    if (v.snmpVersion === '3' && !v.snmpUsername) ctx.addIssue({ code: 'custom', path: ['snmpUsername'], message: 'Enter the SNMPv3 user name.' });
    if (!v.snmpOid || !SNMP_OID.test(v.snmpOid)) ctx.addIssue({ code: 'custom', path: ['snmpOid'], message: 'Enter the OID as dotted numbers, like 1.3.6.1.2.1.1.3.0.' });
    if (!v.snmpOperator) ctx.addIssue({ code: 'custom', path: ['snmpOperator'], message: 'Choose how the value is compared.' });
    if (!v.snmpExpected) ctx.addIssue({ code: 'custom', path: ['snmpExpected'], message: 'Enter the value that means the device is healthy.' });
  })
  .transform((v) => {
    const snmp = v.checkType === 'snmp';
    return {
      ...v,
      port: v.checkType === 'port' ? (v.port ?? null) : snmp ? (v.port ?? SNMP_DEFAULT_PORT) : null,
      snmpVersion: snmp ? (v.snmpVersion ?? null) : null,
      snmpCommunity: snmp && v.snmpVersion !== '3' && v.snmpCommunity ? v.snmpCommunity : null,
      snmpUsername: snmp && v.snmpVersion === '3' ? (v.snmpUsername ?? null) : null,
      snmpOid: snmp ? (v.snmpOid ?? null) : null,
      snmpOperator: snmp ? (v.snmpOperator ?? null) : null,
      snmpExpected: snmp ? (v.snmpExpected ?? null) : null,
    };
  });
type ParsedDevice = z.infer<typeof deviceInventoryInputSchema>;
/** What the API stores. The SNMP fields only matter for an SNMP check, so anything else can leave them out. */
export type DeviceInventoryInput = Omit<ParsedDevice, 'snmpVersion' | 'snmpCommunity' | 'snmpUsername' | 'snmpOid' | 'snmpOperator' | 'snmpExpected'> &
  Partial<Pick<ParsedDevice, 'snmpVersion' | 'snmpCommunity' | 'snmpUsername' | 'snmpOid' | 'snmpOperator' | 'snmpExpected'>>;

export type DeviceSyncState = 'pending' | 'synced' | 'error';

export interface DeviceInventoryRow {
  id: string;
  siteCode: string;
  name: string;
  kind: DeviceKind;
  checkType: DeviceCheckType;
  address: string;
  port: number | null;
  /** SNMP checks only. The community string is secret: only whether one is stored is shown. */
  snmp: { version: SnmpVersion; username: string | null; oid: string; operator: SnmpOperator; expected: string; hasCommunity: boolean } | null;
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

/** What Kuma needs to know to check a device. `snmp.community` is the readable string (the worker decrypts it just before use). */
type Device = Pick<DeviceInventoryRow, 'name' | 'checkType' | 'address' | 'port'> & {
  snmp?: { version: SnmpVersion; community: string | null; username: string | null; oid: string; operator: SnmpOperator; expected: string } | null;
};

/** The fields of a Kuma monitor that Voxshift decides. Everything else is left as Kuma has it. */
export function kumaMonitorFields(d: Device): Record<string, unknown> {
  const common = { name: d.name, interval: DEVICE_CHECK_INTERVAL_SECONDS, retryInterval: DEVICE_CHECK_INTERVAL_SECONDS, maxretries: 1, timeout: 10 };
  if (d.checkType === 'ping') {
    return { ...common, type: 'ping', hostname: d.address, port: null, packetSize: 56, ping_count: 1, ping_numeric: true, ping_per_request_timeout: 2 };
  }
  if (d.checkType === 'snmp' && d.snmp) {
    const q = d.snmp;
    // Kuma keeps the v1/v2c community string in its field "radiusPassword" and the value comparison in the JSON-query fields (the value read is a plain
    // number or text, so the query is just "$"). SNMP is local-network traffic, so Kuma's own default timeout for it is 5 seconds.
    return {
      ...common, timeout: 5, type: 'snmp', hostname: d.address, port: d.port ?? SNMP_DEFAULT_PORT,
      snmpVersion: q.version, radiusPassword: q.version === '3' ? '' : (q.community ?? ''), snmpV3Username: q.version === '3' ? (q.username ?? '') : '',
      snmpOid: q.oid, jsonPath: '$', jsonPathOperator: q.operator, expectedValue: q.expected,
    };
  }
  return { ...common, type: 'port', hostname: d.address, port: d.port };
}

/** The payload for Kuma's `add` event. */
export function kumaNewMonitor(d: Device): Record<string, unknown> {
  const m: Record<string, unknown> = { ...KUMA_MONITOR_DEFAULTS, ...kumaMonitorFields(d) };
  delete m.url; // a ping, port or SNMP monitor has no URL
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
