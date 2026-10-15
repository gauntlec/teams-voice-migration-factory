import { describe, expect, it } from 'vitest';
import { HUB_OK_WITHIN_SECONDS, HUB_TOKEN_RE, connectHubSchema, hubErrorText, hubLinkState, type HubConnectionView } from './hub-connection';

const token = `vxh_b04e6c2c-d276-4c12-a477-0554a8b34d20_${'ab12'.repeat(12)}`;
const view = (over: Partial<HubConnectionView> = {}): HubConnectionView => ({ connected: true, hubUrl: 'https://hub.voxshift.io', tokenHint: '…ab12', lastAttemptAt: null, lastOkAt: null, lastError: null, remoteAccess: false, tunnelState: 'off', tunnelError: null, ...over });

describe('connecting to a hub', () => {
  it('takes the address and an instance token, and tidies the address', () => {
    expect(connectHubSchema.parse({ hubUrl: 'https://hub.voxshift.io/', token })).toEqual({ hubUrl: 'https://hub.voxshift.io', token });
    expect(HUB_TOKEN_RE.test(token)).toBe(true);
  });
  it('refuses a token of the wrong shape, an address with a path, and extra fields', () => {
    expect(connectHubSchema.safeParse({ hubUrl: 'https://hub.voxshift.io', token: 'vxs_agent_1_2' }).success).toBe(false);
    expect(connectHubSchema.safeParse({ hubUrl: 'https://hub.voxshift.io/app', token }).success).toBe(false);
    expect(connectHubSchema.safeParse({ hubUrl: 'https://hub.voxshift.io', token, extra: 1 }).success).toBe(false);
  });
});

describe('link state', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  it('says what is going on in four words', () => {
    expect(hubLinkState(view({ connected: false }), now)).toBe('not_connected');
    expect(hubLinkState(view(), now)).toBe('waiting');
    expect(hubLinkState(view({ lastOkAt: ago(30) }), now)).toBe('ok');
    expect(hubLinkState(view({ lastOkAt: ago(HUB_OK_WITHIN_SECONDS + 1) }), now)).toBe('failing');
    expect(hubLinkState(view({ lastOkAt: ago(10), lastError: 'x' }), now)).toBe('failing');
  });
  it('words the failures without a token', () => {
    expect(hubErrorText(401)).toMatch(/rotated/);
    expect(hubErrorText(null, 'ENOTFOUND')).toBe('Could not reach the hub: ENOTFOUND.');
  });
});
