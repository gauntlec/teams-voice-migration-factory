import { describe, expect, it } from 'vitest';
import {
  decodeCallQueueEnum,
  normalizePstnTarget,
  planCallQueueRow,
  type BuildCallQueueRow,
  type CallQueueLiveState,
} from './deployment';

describe('normalizePstnTarget', () => {
  it('prefixes a bare number with tel:', () => {
    expect(normalizePstnTarget('+441234567890')).toBe('tel:+441234567890');
  });

  it('passes an already tel:-prefixed value through unchanged', () => {
    expect(normalizePstnTarget('tel:+441234567890')).toBe('tel:+441234567890');
  });

  it('is case-insensitive on the tel: prefix', () => {
    expect(normalizePstnTarget('TEL:+441234567890')).toBe('TEL:+441234567890');
  });

  it('passes a GUID through unchanged (no tel: prefix)', () => {
    const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(normalizePstnTarget(guid)).toBe(guid);
  });

  it('trims whitespace before deciding', () => {
    expect(normalizePstnTarget('  +441234567890  ')).toBe('tel:+441234567890');
  });
});

describe('decodeCallQueueEnum', () => {
  const values = ['DisconnectWithBusy', 'Forward', 'Voicemail', 'SharedVoicemail'] as const;

  it('passes a string value through unchanged', () => {
    expect(decodeCallQueueEnum('SharedVoicemail', values)).toBe('SharedVoicemail');
  });

  it('decodes a numeric enum index to its string name', () => {
    expect(decodeCallQueueEnum(3, values)).toBe('SharedVoicemail');
    expect(decodeCallQueueEnum(0, values)).toBe('DisconnectWithBusy');
  });

  it('returns undefined for a numeric index out of range', () => {
    expect(decodeCallQueueEnum(99, values)).toBeUndefined();
  });

  it('returns undefined for a value that is neither string nor number', () => {
    expect(decodeCallQueueEnum(null, values)).toBeUndefined();
    expect(decodeCallQueueEnum(undefined, values)).toBeUndefined();
  });
});

describe('planCallQueueRow', () => {
  const baseRow: BuildCallQueueRow = {
    id: 'row-1',
    name: 'Sales Queue',
    routing_method: 'RoundRobin',
    agent_alert_time: 20,
    presence_based_routing: true,
    agents: [],
    overflow: null,
    timeout: null,
    no_agent_action: null,
    no_agent_apply_to: null,
    language_id: null,
    resource_accounts: [],
  };

  it('emits New-CsCallQueue when there is no live state', () => {
    const calls = planCallQueueRow(baseRow, new Map(), new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmdlet).toBe('New-CsCallQueue');
    expect(calls[0]!.parameters.Name).toBe('Sales Queue');
    expect(calls[0]!.objectType).toBe('call_queue');
    expect(calls[0]!.objectId).toBe('row-1');
  });

  it('emits nothing when live state already matches the row exactly', () => {
    const live: CallQueueLiveState = {
      identity: 'live-guid-1',
      routingMethod: 'RoundRobin',
      agentAlertTime: 20,
      presenceBasedRouting: true,
      agentObjectIds: [],
    };
    const calls = planCallQueueRow(baseRow, new Map(), new Map(), live);
    expect(calls).toHaveLength(0);
  });

  it('emits Set-CsCallQueue with the live Identity when a field differs', () => {
    const live: CallQueueLiveState = {
      identity: 'live-guid-1',
      routingMethod: 'Serial', // differs from baseRow's 'RoundRobin'
      agentAlertTime: 20,
      presenceBasedRouting: true,
      agentObjectIds: [],
    };
    const calls = planCallQueueRow(baseRow, new Map(), new Map(), live);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmdlet).toBe('Set-CsCallQueue');
    expect(calls[0]!.parameters.Identity).toBe('live-guid-1');
    expect(calls[0]!.parameters.RoutingMethod).toBe('RoundRobin');
  });

  it('resolves a Forward target UPN to its Entra object id via agentObjectIds', () => {
    const row: BuildCallQueueRow = {
      ...baseRow,
      overflow: { action: 'Forward', target: 'reception@contoso.com' },
    };
    const agentObjectIds = new Map([['reception@contoso.com', 'reception-guid']]);
    const calls = planCallQueueRow(row, agentObjectIds, new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.parameters.OverflowActionTarget).toBe('reception-guid');
  });

  it('falls back to normalizePstnTarget for a Forward target that is not a resolvable UPN', () => {
    const row: BuildCallQueueRow = {
      ...baseRow,
      overflow: { action: 'Forward', target: '+441234567890' },
    };
    const calls = planCallQueueRow(row, new Map(), new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.parameters.OverflowActionTarget).toBe('tel:+441234567890');
  });

  it('associates a newly linked resource account once the queue has a live identity', () => {
    const row: BuildCallQueueRow = { ...baseRow, resource_accounts: ['ra-1'] };
    const raObjectIds = new Map([['ra-1', 'app-instance-guid']]);
    const live: CallQueueLiveState = {
      identity: 'live-guid-1',
      routingMethod: 'RoundRobin',
      agentAlertTime: 20,
      presenceBasedRouting: true,
      agentObjectIds: [],
      applicationInstanceIds: [],
    };
    const calls = planCallQueueRow(row, new Map(), raObjectIds, live);
    const assoc = calls.find((c) => c.cmdlet === 'New-CsOnlineApplicationInstanceAssociation');
    expect(assoc).toBeDefined();
    expect(assoc?.parameters.Identities).toEqual(['app-instance-guid']);
  });

  it('removes a resource account association that was unlinked in Design & Build', () => {
    const raObjectIds = new Map<string, string>(); // nothing linked any more
    const live: CallQueueLiveState = {
      identity: 'live-guid-1',
      routingMethod: 'RoundRobin',
      agentAlertTime: 20,
      presenceBasedRouting: true,
      agentObjectIds: [],
      applicationInstanceIds: ['stale-app-instance-guid'],
    };
    const calls = planCallQueueRow(baseRow, new Map(), raObjectIds, live);
    const removal = calls.find((c) => c.cmdlet === 'Remove-CsOnlineApplicationInstanceAssociation');
    expect(removal).toBeDefined();
    expect(removal?.parameters.Identities).toEqual(['stale-app-instance-guid']);
  });
});
