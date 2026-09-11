/**
 * Abstraction over "talk to the connected customer tenant with the
 * MicrosoftTeams PowerShell module". Two implementations:
 *
 *  - PwshTeamsExecutor       (teams/pwsh-executor.ts) - a real `pwsh` child
 *      running the MicrosoftTeams module, signed in live by device code.
 *  - SimulatedTeamsExecutor  (below) - no PowerShell; returns a small fake
 *      dataset so the app can be developed/tested without a customer tenant.
 *      Selected with TEAMS_EXECUTOR=simulated.
 *
 * SECURITY: an executor holds the customer session ONLY in memory (inside the
 * pwsh process) for the life of the connection. It is never returned, logged,
 * or persisted. See docs/SECURITY.md.
 */

import { type CmdletInvocation, renderCommand } from '@tvmf/shared';

export type { CmdletInvocation };
export { renderCommand };

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
}

export interface CmdletResult {
  result: 'applied' | 'skipped' | 'failed' | 'whatif';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  message?: string;
}

/** Per-call tuning for `query()` - big pulls need a longer leash + smaller payload. */
export interface QueryOpts {
  /** ConvertTo-Json depth (default 6). */
  depth?: number;
  /** override the executor's command timeout for this call */
  timeoutMs?: number;
  /** `Select-Object` these properties before serialising - keeps a huge result small */
  select?: readonly string[];
}

export interface TeamsExecutor {
  /** Begin device-code sign-in; resolves once the code is available to show. */
  beginDeviceCode(tenantDomain: string | null): Promise<DeviceCodePrompt>;
  /** Resolves when the engineer has completed sign-in (or rejects on timeout). */
  awaitSignIn(): Promise<{ upn: string; tenantId: string }>;
  /** Run a read-only Get-Cs* cmdlet and return its records (used by Discovery). */
  query(command: string, params?: Record<string, unknown>, opts?: QueryOpts): Promise<unknown[]>;
  /** Run one cmdlet. `whatIf` => generate the command text, do not change anything. */
  invoke(call: CmdletInvocation, opts: { whatIf: boolean }): Promise<CmdletResult>;
  /** Tear down the pwsh session and wipe the token from memory. */
  dispose(): Promise<void>;
  /**
   * False once the pwsh process / Teams session is genuinely gone (the child
   * exited, was disposed by the idle sweeper, or never started). A single slow
   * or failing cmdlet does NOT flip this - the discovery runner uses it to tell
   * "this step errored" from "the sign-in is lost, stop the run".
   */
  readonly alive: boolean;
  /** epoch ms of the last command - lets main.ts expire idle sessions. */
  lastUsedAt: number;
}

/* ------------------------------ simulated ------------------------------ */

const SIM_TENANT = '11111111-2222-3333-4444-555555555555';

/** Fake records keyed by cmdlet, shaped like the real module output. */
const SIM_DATA: Record<string, unknown[]> = {
  'Get-CsTenant': [
    { TenantId: SIM_TENANT, DisplayName: 'Simulated Customer Ltd', Domains: ['customer.example', 'customer.onmicrosoft.com'] },
  ],
  'Get-CsOnlineUser': [
    {
      Identity: 'a1a1a1a1-0000-0000-0000-000000000001',
      UserPrincipalName: 'amanda.keen@parker.com',
      DisplayName: 'Amanda Keen',
      AccountType: 'User',
      AccountEnabled: true,
      EnterpriseVoiceEnabled: true,
      LineUri: 'tel:+19133743143',
      TelephoneNumbers: [{ TelephoneNumber: '+19133743143', AssignmentCategory: 'Primary' }],
      FeatureTypes: ['Teams', 'PhoneSystem', 'AudioConferencing'],
      AssignedPlan: [{ Capability: 'MCOEV', AssignedTimestamp: '2025-01-01T00:00:00Z', CapabilityStatus: 'Enabled' }],
      UsageLocation: 'US',
      Department: 'Finance',
      Title: 'Analyst',
      InterpretedUserType: 'PureOnlineTeamsOnlyUser',
      TeamsCallingPolicy: { Name: 'Sales', Authority: 'Tenant' },
      OnlineVoiceRoutingPolicy: 'US-Routing',
      TenantDialPlan: 'US',
      TeamsEmergencyCallingPolicy: 'Global',
      OnlineVoicemailPolicy: 'Global',
      CallingLineIdentity: 'MainNumber',
      EffectivePolicyAssignments: [{ PolicyType: 'TeamsCallingPolicy', PolicyAssignment: { displayName: 'Sales', assignmentType: 'Direct' } }],
      WhenChanged: '2026-08-01T10:00:00Z',
    },
    {
      Identity: 'a1a1a1a1-0000-0000-0000-000000000002',
      UserPrincipalName: 'new.starter@parker.com',
      DisplayName: 'New Starter',
      AccountType: 'User',
      AccountEnabled: true,
      EnterpriseVoiceEnabled: true,
      LineUri: 'tel:+19133743199',
      TelephoneNumbers: [{ TelephoneNumber: '+19133743199', AssignmentCategory: 'Primary' }],
      FeatureTypes: ['Teams', 'PhoneSystem'],
      AssignedPlan: [{ Capability: 'MCOEV', CapabilityStatus: 'Enabled' }],
      UsageLocation: 'US',
      Department: 'Operations',
      Title: 'Coordinator',
      InterpretedUserType: 'PureOnlineTeamsOnlyUser',
      TeamsCallingPolicy: 'Global',
      OnlineVoiceRoutingPolicy: 'US-Routing',
      WhenChanged: '2026-09-01T10:00:00Z',
    },
    {
      Identity: 'a1a1a1a1-0000-0000-0000-000000000003',
      UserPrincipalName: 'no.voice@parker.com',
      DisplayName: 'No Voice',
      AccountType: 'User',
      AccountEnabled: true,
      EnterpriseVoiceEnabled: false,
      FeatureTypes: ['Teams'],
      AssignedPlan: [],
      UsageLocation: 'US',
      Department: 'Marketing',
      InterpretedUserType: 'PureOnlineTeamsOnlyUser',
      TeamsCallingPolicy: 'Global',
    },
    {
      Identity: 'a1a1a1a1-0000-0000-0000-000000000009',
      UserPrincipalName: 'ra-mainaa@parker.com',
      DisplayName: 'Main Auto Attendant',
      AccountType: 'ResourceAccount',
      AccountEnabled: true,
      EnterpriseVoiceEnabled: true,
      LineUri: 'tel:+19133743100',
      FeatureTypes: ['VoiceApp'],
      AssignedPlan: [{ Capability: 'MCOEV_VIRTUALUSER', CapabilityStatus: 'Enabled' }],
      UsageLocation: 'US',
    },
  ],
  'Get-CsOnlineApplicationInstance': [
    {
      ObjectId: 'a1a1a1a1-0000-0000-0000-000000000009',
      UserPrincipalName: 'ra-mainaa@parker.com',
      DisplayName: 'Main Auto Attendant',
      ApplicationId: 'ce933385-9390-45d1-9512-c8d228074e07',
      PhoneNumber: 'tel:+19133743100',
    },
  ],
  'Get-CsPhoneNumberAssignment': [
    { TelephoneNumber: '+19133743143', NumberType: 'DirectRouting', AssignedPstnTargetId: 'a1a1a1a1-0000-0000-0000-000000000001', ActivationState: 'Activated', IsoCountryCode: 'US' },
    { TelephoneNumber: '+19133743199', NumberType: 'DirectRouting', AssignedPstnTargetId: 'a1a1a1a1-0000-0000-0000-000000000002', ActivationState: 'Activated', IsoCountryCode: 'US' },
    { TelephoneNumber: '+19133743100', NumberType: 'DirectRouting', AssignedPstnTargetId: 'a1a1a1a1-0000-0000-0000-000000000009', ActivationState: 'Activated', IsoCountryCode: 'US' },
  ],
  'Get-CsTeamsCallingPolicy': [
    { Identity: 'Global', AllowPrivateCalling: true, AllowCallForwardingToPhone: true, AllowVoicemail: 'UserOverride' },
    { Identity: 'Tag:Sales', AllowPrivateCalling: true, AllowCallForwardingToPhone: false, AllowVoicemail: 'AlwaysEnabled' },
  ],
  'Get-CsOnlineVoiceRoutingPolicy': [
    { Identity: 'Global', OnlinePstnUsages: [] },
    { Identity: 'Tag:US-Routing', OnlinePstnUsages: ['US-Local', 'US-International'] },
  ],
  'Get-CsTenantDialPlan': [{ Identity: 'Tag:US', NormalizationRules: [{ Name: 'US-10digit', Pattern: '^(\\d{10})$', Translation: '+1$1' }] }],
  'Get-CsOnlinePSTNGateway': [{ Identity: 'sbc.customer.example', Fqdn: 'sbc.customer.example', SipSignalingPort: 5061, Enabled: true }],
  'Get-CsOnlinePstnUsage': [{ Identity: 'Global', Usage: ['US-Local', 'US-International'] }],
  'Get-CsOnlineVoiceRoute': [
    { Identity: 'US-All', Name: 'US-All', NumberPattern: '^\\+1(\\d{10})$', OnlinePstnGatewayList: ['sbc.customer.example'], OnlinePstnUsages: ['US-Local'], Priority: 1 },
  ],
  'Get-CsOnlineLisLocation': [
    { LocationId: 'loc-0001', Location: 'Overland Park HQ - Floor 1', HouseNumber: '11501', StreetName: 'Outlook St', City: 'Overland Park', CountryOrRegion: 'US', CivicAddressId: 'ca-0001' },
  ],
  'Get-CsOnlineLisCivicAddress': [
    { CivicAddressId: 'ca-0001', Description: 'Overland Park HQ', HouseNumber: '11501', StreetName: 'Outlook St', City: 'Overland Park', CountryOrRegion: 'US', ValidationStatus: 'Validated' },
  ],
  'Get-CsAutoAttendant': [
    { Identity: 'aa-0001', Name: 'Main Auto Attendant', LanguageId: 'en-US', TimeZoneId: 'Central Standard Time', ApplicationInstances: ['a1a1a1a1-0000-0000-0000-000000000009'] },
  ],
  'Get-CsCallQueue': [
    { Identity: 'cq-0001', Name: 'Support Queue', RoutingMethod: 'Attendant', Agents: [{ ObjectId: 'a1a1a1a1-0000-0000-0000-000000000001' }], AgentAlertTime: 30 },
  ],
  'Get-CsOnlineSchedule': [{ Id: 'sch-0001', Name: 'Business Hours', Type: 'WeeklyRecurrence' }],
};

export class SimulatedTeamsExecutor implements TeamsExecutor {
  private signedIn = false;
  lastUsedAt = Date.now();

  get alive(): boolean {
    return this.signedIn;
  }

  async beginDeviceCode(_tenantDomain: string | null = null): Promise<DeviceCodePrompt> {
    return {
      userCode: 'SIMULATED-CODE',
      verificationUri: 'https://microsoft.com/devicelogin',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  async awaitSignIn(): Promise<{ upn: string; tenantId: string }> {
    await new Promise((r) => setTimeout(r, 3000));
    this.signedIn = true;
    this.lastUsedAt = Date.now();
    return { upn: 'engineer@customer.example', tenantId: SIM_TENANT };
  }

  async query(
    command: string,
    params: Record<string, unknown> = {},
    _opts: QueryOpts = {},
  ): Promise<unknown[]> {
    if (!this.signedIn) throw new Error('not connected');
    this.lastUsedAt = Date.now();
    // one page only: any Skip > 0 is past the end of the fake data
    if (Number(params.Skip ?? 0) > 0) return [];
    // every other Get-Cs*Policy type gets just a Global policy
    if (!(command in SIM_DATA) && /^Get-Cs.*(Policy|Identity|DialPlan)$/.test(command)) {
      return [{ Identity: 'Global', Simulated: true }];
    }
    return SIM_DATA[command] ?? [];
  }

  async invoke(call: CmdletInvocation, opts: { whatIf: boolean }): Promise<CmdletResult> {
    if (!this.signedIn) return { result: 'failed', before: {}, after: {}, message: 'not connected' };
    this.lastUsedAt = Date.now();
    const rendered = renderCommand(call);
    if (opts.whatIf) {
      return { result: 'whatif', before: {}, after: {}, message: rendered };
    }
    return {
      result: 'applied',
      before: { simulated: true },
      after: { simulated: true, ...call.parameters },
      message: `simulated: ${rendered}`,
    };
  }

  async dispose(): Promise<void> {
    this.signedIn = false;
  }
}
