import { describe, expect, it } from 'vitest';
import { deviceAutoSetupSchema, deviceInventoryInputSchema, isTenantStatusSlug, kumaMonitorFields, kumaNewMonitor, kumaSlugForTenant, kumaTagsFor, planTagChanges } from './device-inventory';

const ok = { siteCode: 'LTN01', name: 'Door paging', kind: 'algo', checkType: 'ping', address: '10.1.2.3' } as const;

describe('deviceInventoryInputSchema', () => {
  it('accepts a ping device and clears the port', () => {
    expect(deviceInventoryInputSchema.parse({ ...ok, port: 80 })).toEqual({ ...ok, port: null });
  });
  it('needs a port for a TCP check', () => {
    expect(deviceInventoryInputSchema.safeParse({ ...ok, checkType: 'port' }).success).toBe(false);
    expect(deviceInventoryInputSchema.parse({ ...ok, checkType: 'port', port: 5060 }).port).toBe(5060);
  });
  it('takes host names and IPv6, and refuses URLs and spaces', () => {
    for (const a of ['paging.contoso.local', '192.168.1.20', 'fe80::1', 'a']) expect(deviceInventoryInputSchema.safeParse({ ...ok, address: a }).success, a).toBe(true);
    for (const a of ['http://10.1.2.3', '10.1.2.3/24', 'bad host', '', '-x.com', '10.1.2.3:80']) expect(deviceInventoryInputSchema.safeParse({ ...ok, address: a }).success, a).toBe(false);
  });
  it('refuses an unknown kind and a bad port', () => {
    expect(deviceInventoryInputSchema.safeParse({ ...ok, kind: 'toaster' }).success).toBe(false);
    expect(deviceInventoryInputSchema.safeParse({ ...ok, checkType: 'port', port: 70000 }).success).toBe(false);
  });
});

describe('Kuma monitor payloads', () => {
  it('builds a ping monitor at Kuma\'s shortest interval, with no URL', () => {
    const m = kumaNewMonitor({ name: 'Door', checkType: 'ping', address: '10.1.2.3', port: null });
    expect(m).toMatchObject({ type: 'ping', name: 'Door', hostname: '10.1.2.3', interval: 20, retryInterval: 20, maxretries: 1, accepted_statuscodes: ['200-299'] });
    expect('url' in m).toBe(false);
  });
  it('builds a port monitor', () => {
    expect(kumaMonitorFields({ name: 'DECT', checkType: 'port', address: 'dect.local', port: 5060 })).toMatchObject({ type: 'port', hostname: 'dect.local', port: 5060 });
  });
  it('tags a device with its site and kind', () => {
    expect(kumaTagsFor({ siteCode: 'LTN01', kind: 'algo' })).toEqual([{ name: 'site', value: 'LTN01' }, { name: 'device', value: 'algo' }]);
  });
});

describe('planTagChanges', () => {
  const wanted = [{ name: 'site', value: 'LTN01' }, { name: 'device', value: 'algo' }];
  it('adds what is missing', () => {
    expect(planTagChanges(wanted, [])).toEqual({ remove: [], add: wanted });
  });
  it('does nothing when it already matches', () => {
    expect(planTagChanges(wanted, [{ tag_id: 1, name: 'site', value: 'LTN01' }, { tag_id: 2, name: 'device', value: 'algo' }])).toEqual({ remove: [], add: [] });
  });
  it('replaces a changed value, and leaves other tags alone', () => {
    const r = planTagChanges(wanted, [{ tag_id: 1, name: 'site', value: 'OLD' }, { tag_id: 2, name: 'device', value: 'algo' }, { tag_id: 9, name: 'owner', value: 'ops' }]);
    expect(r).toEqual({ remove: [{ tagId: 1, value: 'OLD' }], add: [{ name: 'site', value: 'LTN01' }] });
  });
  it('removes a duplicate of a wanted tag', () => {
    const r = planTagChanges(wanted, [{ tag_id: 1, name: 'site', value: 'LTN01' }, { tag_id: 1, name: 'site', value: 'LTN01' }, { tag_id: 2, name: 'device', value: 'algo' }]);
    expect(r.remove).toHaveLength(1);
    expect(r.add).toEqual([]);
  });
});

describe('deviceAutoSetupSchema', () => {
  it('everything is optional, and a path in the address is refused', () => {
    expect(deviceAutoSetupSchema.parse({})).toEqual({});
    expect(deviceAutoSetupSchema.parse({ kumaUrl: 'http://kuma:3001/' }).kumaUrl).toBe('http://kuma:3001');
    expect(deviceAutoSetupSchema.safeParse({ kumaUrl: 'http://kuma:3001/x' }).success).toBe(false);
  });
});

describe('kumaSlugForTenant', () => {
  const a = '3f2b9c1e-7d4a-4e8b-9a61-0c5d2e7f8a10';
  const b = '9a1c7e55-2b3d-4f60-8e11-aa00bb22cc33';
  it('is a lower-case address of letters, digits and dashes that the service accepts, and is stable', () => {
    expect(kumaSlugForTenant(a)).toBe('voxshift-3f2b9c1e7d4a');
    expect(kumaSlugForTenant(a)).toBe(kumaSlugForTenant(a));
    expect(kumaSlugForTenant(a)).toMatch(/^[a-z0-9-]{1,64}$/);
  });
  it('differs for different customers', () => {
    expect(kumaSlugForTenant(a)).not.toBe(kumaSlugForTenant(b));
  });
  it('recognises an address made for a customer, and not other names', () => {
    expect(isTenantStatusSlug(kumaSlugForTenant(a))).toBe(true);
    for (const x of ['voxshift', 'voxshift-xyz', 'voxshift-3f2b9c1e7d4', 'my-page', 'VOXSHIFT-3F2B9C1E7D4A']) expect(isTenantStatusSlug(x), x).toBe(false);
  });
});
