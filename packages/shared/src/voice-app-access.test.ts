// PowerShell-only access settings on auto attendants and call queues: authorised users, hidden ones, dial-by-name extension,
// voicemail triage template. null in the design = not managed, so Teams' own value is left alone.
import { describe, expect, it } from 'vitest';
import { planAutoAttendantRow, planCallQueueRow, renderCommand, type AutoAttendantLiveState, type BuildAutoAttendantRow, type BuildCallQueueRow, type CallQueueLiveState } from './deployment';
import { accessWarnings, decodeUserNameExtension, liveIdList, sameIds } from './voice-app-access';

const ANN = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ids = new Map([['ann@contoso.test', ANN], ['bob@contoso.test', BOB]]);

describe('helpers', () => {
  it('read ids and enums as Teams writes them', () => {
    expect(liveIdList([ANN, { Id: BOB }, 3])).toEqual([ANN, BOB]);
    expect(liveIdList(undefined)).toBeUndefined();
    expect(decodeUserNameExtension(2)).toBe('Department');
    expect(decodeUserNameExtension('office')).toBe('Office');
    expect(sameIds([ANN.toUpperCase(), BOB], [BOB, ANN])).toBe(true);
  });
  it('warns about unknown people and hidden people who are not authorised', () => {
    expect(accessWarnings(['ann@contoso.test'], ['bob@contoso.test'], ids)).toEqual(['Hidden authorised users must also be authorised users: bob@contoso.test']);
    expect(accessWarnings(['zed@contoso.test'], null, ids)[0]).toMatch(/not found.*zed@contoso.test/);
  });
});

const cq: BuildCallQueueRow = {
  id: 'cq', name: 'Sales', routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: [],
  overflow: null, timeout: null, no_agent_action: null, no_agent_apply_to: null, language_id: null, resource_accounts: [],
};
const cqLive: CallQueueLiveState = { identity: 'q', routingMethod: 'RoundRobin', agentAlertTime: 20, presenceBasedRouting: true, agentObjectIds: [], authorizedUsers: [ANN, BOB], hideAuthorizedUsers: [BOB] };

describe('call queue', () => {
  it('leaves unmanaged (null) access alone, even when Teams has some', () => {
    expect(planCallQueueRow(cq, ids, new Map(), cqLive)).toEqual([]);
  });
  it('matches when the design has the same people', () => {
    expect(planCallQueueRow({ ...cq, authorized_users: ['bob@contoso.test', 'ann@contoso.test'], hide_authorized_users: ['bob@contoso.test'] }, ids, new Map(), cqLive)).toEqual([]);
  });
  it('sets the lists and the triage template when they differ; an empty list clears', () => {
    const calls = planCallQueueRow({ ...cq, authorized_users: ['ann@contoso.test'], hide_authorized_users: [], voicemail_triage_template_id: '33333333-3333-4333-8333-333333333333' }, ids, new Map(), cqLive);
    expect(calls).toHaveLength(1);
    expect(renderCommand(calls[0]!)).toContain(`-AuthorizedUsers @('${ANN}') -HideAuthorizedUsers @() -SharedVoicemailTriageSettingsTemplateId '33333333-3333-4333-8333-333333333333'`);
  });
});

const flow = { greetings: [], menu: { options: [{ dtmf: 'Automatic' as const, action: 'DisconnectCall' as const }] } };
const aa: BuildAutoAttendantRow = {
  id: 'aa', name: 'Main', language_id: 'en-GB', time_zone_id: 'GMT Standard Time', voice_id: null, voice_response_enabled: false,
  operator: null, default_call_flow: flow, after_hours_call_flow: null, holiday_call_flows: [], schedule: null, resource_accounts: [],
};
const aaLive: AutoAttendantLiveState = {
  identity: 'live-aa',
  structured: { languageId: 'en-GB', timeZoneId: 'GMT Standard Time', operator: null, defaultCallFlow: flow, afterHoursCallFlow: null, holidayCallFlows: [], schedule: null, authorizedUsers: [ANN], hideAuthorizedUsers: [], userNameExtension: 'None' },
};

describe('auto attendant', () => {
  it('creates with the access settings and dial-by-name extension', () => {
    const [call] = planAutoAttendantRow({ ...aa, authorized_users: ['ann@contoso.test'], hide_authorized_users: ['ann@contoso.test'], user_name_extension: 'Department' }, new Map(), new Map(), ids);
    expect(call!.parameters).toMatchObject({ AuthorizedUsers: [ANN], HideAuthorizedUsers: [ANN], UserNameExtension: 'Department' });
  });
  it('plans nothing when unmanaged or matching, and sets them on the instance when different', () => {
    expect(planAutoAttendantRow(aa, new Map(), new Map(), ids, aaLive)).toEqual([]);
    expect(planAutoAttendantRow({ ...aa, authorized_users: ['ann@contoso.test'], user_name_extension: 'None' }, new Map(), new Map(), ids, aaLive)).toEqual([]);
    const [call] = planAutoAttendantRow({ ...aa, user_name_extension: 'Office' }, new Map(), new Map(), ids, aaLive);
    expect(call!.cmdlet).toBe('Set-CsAutoAttendant');
    expect(renderCommand(call!)).toContain(`$aa.UserNameExtension = 'Office'`);
  });
});
