import { describe, expect, it } from 'vitest';
import { planAutoAttendantRow, planCallQueueRow, renderCommand, type BuildAutoAttendantRow, type BuildCallQueueRow } from './deployment';

// A new call queue or auto attendant is linked to its resource account in the same run (New-CsOnlineApplicationInstanceAssociation needs
// the new object's id, read back by exact name), instead of only on a second deployment after a Discovery sync.
const RA = 'ra-build';
const RA_LIVE = '4329bcbc-0000-0000-0000-000000000001';

const queue = (over: Partial<BuildCallQueueRow> = {}): BuildCallQueueRow => ({
  id: 'q1', name: 'Sales', routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: [],
  overflow: null, timeout: null, no_agent_action: null, no_agent_apply_to: null, language_id: 'en-GB', resource_accounts: [RA],
  authorized_users: null, hide_authorized_users: null, voicemail_triage_template_id: null, ...over,
});
const attendant = (over: Partial<BuildAutoAttendantRow> = {}) =>
  ({
    id: 'a1', name: 'Main Number', language_id: 'en-GB', time_zone_id: 'GMT Standard Time', voice_id: null, voice_response_enabled: false, operator: null,
    default_call_flow: { greetings: [{ type: 'Text', text: 'Hello.' }], menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] } },
    after_hours_call_flow: null, schedule: null, holiday_call_flows: [], resource_accounts: [RA], authorized_users: null, hide_authorized_users: null, user_name_extension: null,
    ...over,
  }) as BuildAutoAttendantRow;
const ras = new Map([[RA, RA_LIVE]]);

describe('linking a new call queue to its resource account', () => {
  it('creates the queue, then reads it back by exact name and links it, in the same run', () => {
    const calls = planCallQueueRow(queue(), new Map(), ras);
    expect(calls.map((c) => c.cmdlet)).toEqual(['New-CsCallQueue', 'New-CsOnlineApplicationInstanceAssociation']);
    expect(renderCommand(calls[1]!)).toBe(
      `$created = Get-CsCallQueue -NameFilter 'Sales' | Where-Object { $_.Name -eq 'Sales' }\nNew-CsOnlineApplicationInstanceAssociation -Identities @('${RA_LIVE}') -ConfigurationId $created.Identity -ConfigurationType 'CallQueue'`,
    );
    expect(calls[1]).toMatchObject({ objectType: 'call_queue', objectId: 'q1' });
  });

  it("doesn't plan a link for an account that isn't in Teams yet, or a queue with none", () => {
    expect(planCallQueueRow(queue(), new Map(), new Map()).map((c) => c.cmdlet)).toEqual(['New-CsCallQueue']);
    expect(planCallQueueRow(queue({ resource_accounts: [] }), new Map(), ras).map((c) => c.cmdlet)).toEqual(['New-CsCallQueue']);
  });

  it('links an existing queue by its known id, as before', () => {
    const live = { identity: 'cq-live', routingMethod: 'RoundRobin', agentAlertTime: 20, presenceBasedRouting: true, agentObjectIds: [], languageId: 'en-GB', applicationInstanceIds: [] };
    const calls = planCallQueueRow(queue(), new Map(), ras, live as never);
    expect(calls.map((c) => [c.cmdlet, c.parameters.ConfigurationId])).toEqual([['New-CsOnlineApplicationInstanceAssociation', 'cq-live']]);
  });
});

describe('linking a new auto attendant to its resource account', () => {
  it('creates the attendant, then reads it back by exact name and links it, in the same run', () => {
    const calls = planAutoAttendantRow(attendant(), new Map(), ras, new Map());
    expect(calls.map((c) => c.cmdlet)).toEqual(['New-CsAutoAttendant', 'New-CsOnlineApplicationInstanceAssociation']);
    expect(renderCommand(calls[1]!)).toBe(
      `$created = Get-CsAutoAttendant -NameFilter 'Main Number' | Where-Object { $_.Name -eq 'Main Number' }\nNew-CsOnlineApplicationInstanceAssociation -Identities @('${RA_LIVE}') -ConfigurationId $created.Identity -ConfigurationType 'AutoAttendant'`,
    );
  });

  it("doesn't plan a link when the attendant itself can't be created yet", () => {
    expect(planAutoAttendantRow(attendant({ language_id: null }), new Map(), ras, new Map())).toEqual([]);
  });
});
