import { describe, expect, it } from 'vitest';
import {
  decodeCallQueueEnum,
  normalizePstnTarget,
  planCallQueueRow,
  planIdentityRow,
  renderCommand,
  type BuildIdentityRow,
  psQuote,
  renderExportScript,
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

describe('psQuote (PowerShell single-quoted literals)', () => {
  it('doubles a straight apostrophe, as before', () => {
    expect(psQuote("it's")).toBe("'it''s'");
  });

  it('doubles each smart single quote so it cannot end the literal', () => {
    // U+2019 right single quote, U+2018 left, U+201A low, U+201B reversed.
    expect(psQuote('Sales\u2019 Queue')).toBe("'Sales\u2019\u2019 Queue'");
    expect(psQuote('\u2018x\u201A\u201B')).toBe("'\u2018\u2018x\u201A\u201A\u201B\u201B'");
  });

  it('leaves smart double quotes alone (harmless inside a single-quoted literal)', () => {
    expect(psQuote('\u201Cquoted\u201D')).toBe("'\u201Cquoted\u201D'");
  });

  it('keeps a name with a smart apostrophe in the rendered New-CsCallQueue command', () => {
    const [call] = planCallQueueRow(
      {
        id: 'cq-q',
        name: 'Sales\u2019 Queue',
        routing_method: 'Serial',
        agent_alert_time: 30,
        presence_based_routing: false,
        agents: [],
        overflow: null,
        timeout: null,
        no_agent_action: null,
        no_agent_apply_to: null,
        language_id: null,
        resource_accounts: [],
      },
      new Map(),
      new Map(),
    );
    expect(call?.parameters.Name).toBe('Sales\u2019 Queue');
  });
});

describe('renderExportScript', () => {
  const script = renderExportScript(["New-CsCallQueue -Name 'Sales'", "Set-CsCallQueue -Identity 'x'"], { deploymentId: 'dep-1' });

  it('stops at the first error, as the live path does for each object', () => {
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('connects before the commands and always disconnects after them', () => {
    const lines = script.split('\n');
    expect(lines.indexOf('Connect-MicrosoftTeams')).toBeLessThan(lines.indexOf("New-CsCallQueue -Name 'Sales'"));
    expect(lines.indexOf('} finally {')).toBeGreaterThan(lines.indexOf("Set-CsCallQueue -Identity 'x'"));
    expect(script).toContain('  Disconnect-MicrosoftTeams');
  });

  it('declares the module it needs and names the deployment', () => {
    expect(script.startsWith('#Requires -Modules MicrosoftTeams')).toBe(true);
    expect(script).toContain('deployment dep-1');
  });
});

describe('mandatory parameters are never dropped from a command', () => {
  const identity = (over: Partial<BuildIdentityRow>): BuildIdentityRow => ({
    id: 'u1',
    upn: 'bob@contoso.com',
    e164: null,
    number_type: null,
    revoke_ev: false,
    policies: null,
    voicemail: null,
    call_forwarding: null,
    pickup_group: null,
    delegates: null,
    ...over,
  });

  it('clearing a pickup group sends an explicit empty -CallGroupTargets', () => {
    const calls = planIdentityRow(identity({ pickup_group: { order: 'InOrder', targets: [] } }), 'user');
    expect(renderCommand(calls[0]!)).toBe("Set-CsUserCallingSettings -Identity 'bob@contoso.com' -CallGroupOrder 'InOrder' -CallGroupTargets @()");
  });

  it('still lists the targets when the group has members', () => {
    const calls = planIdentityRow(identity({ pickup_group: { order: 'Simultaneous', targets: ['a@contoso.com', 'b@contoso.com'] } }), 'user');
    expect(renderCommand(calls[0]!)).toContain("-CallGroupTargets @('a@contoso.com', 'b@contoso.com')");
  });

  it('skips a delegate with no UPN instead of emitting New-CsUserCallingDelegate without -Delegate', () => {
    const blank = { delegateUpn: '', makeCalls: true, receiveCalls: true, manageSettings: false, pickUpHeldCalls: false, joinActiveCalls: false };
    const good = { ...blank, delegateUpn: 'carol@contoso.com' };
    const calls = planIdentityRow(identity({ delegates: [blank, { ...blank, delegateUpn: '   ' }, good] }), 'user');
    const delegates = calls.filter((c) => c.cmdlet === 'New-CsUserCallingDelegate');
    expect(delegates).toHaveLength(1);
    expect(delegates[0]!.parameters.Delegate).toBe('carol@contoso.com');
  });
});
