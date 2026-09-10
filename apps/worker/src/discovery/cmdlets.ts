import {
  TENANT_POLICY_TYPES,
  type TenantDiscoveryStep,
  type TenantObjectType,
  type TenantPolicyType,
} from '@tvmf/shared';

/**
 * What each discovery step asks the MicrosoftTeams PowerShell module for, and
 * how to turn each returned record into a `tenant_objects` row. Kept as data so
 * adding an object type is a one-line change here (+ a label in shared/domain.ts).
 * See docs/DISCOVERY.md for the cmdlet reference.
 */

type Rec = Record<string, unknown>;

export interface CmdletSpec {
  /** PowerShell command, without any `| ConvertTo-Json` (the executor appends it). */
  command: string;
  objectType: TenantObjectType;
  /** stable key for upserts (falls back to a hash of the record when empty) */
  key: (r: Rec) => string | null;
  name: (r: Rec) => string | null;
  policyType?: TenantPolicyType;
  /**
   * Paging, where the cmdlet supports it:
   *  - 'first-skip': -First N -Skip M   (Get-CsAutoAttendant, Get-CsCallQueue)
   *  - 'top-skip':   -Top N -Skip M     (Get-CsPhoneNumberAssignment)
   * Get-CsOnlineUser has no -Skip, so it is fetched in one call with a large
   * -ResultSize instead (see `resultSize`).
   */
  page?: { size: number; style: 'first-skip' | 'top-skip' };
  /** single-call cap for cmdlets that can't page (Get-CsOnlineUser -ResultSize) */
  resultSize?: number;
  /** some cmdlets return one object holding an array (PSTN usages) - split it */
  explode?: (r: Rec) => Rec[];
  /** `Select-Object` these before serialising - keeps a huge result small/fast */
  select?: readonly string[];
  /** ConvertTo-Json depth for this cmdlet (default 6) */
  depth?: number;
  /** per-call timeout override (ms) - for cmdlets that can run long on big tenants */
  timeoutMs?: number;
  /**
   * For cmdlets with no `-Skip` (Get-CsOnlineUser): fetch in disjoint slices,
   * one `-Filter` per bucket, so a huge result comes back in visible chunks
   * instead of one opaque multi-minute call. Buckets must not overlap; the
   * runner de-dups on `key(r)` defensively. `opts` are the engineer's include
   * toggles.
   */
  buckets?: (opts: DiscoveryFilterOpts) => { label: string; filter: string }[];
}

/** Engineer toggles that widen the user sync beyond migration candidates. */
export interface DiscoveryFilterOpts {
  /** also fetch AccountEnabled = false accounts */
  includeDisabled?: boolean;
  /** also fetch Guest / IneligibleUser and keep accounts not licensed for Teams */
  includeUnlicensed?: boolean;
  /**
   * Customer-level default (Discovery settings). `false` = store every enabled
   * `User` account, don't filter down to Teams-licensed ones. Undefined = filter
   * (the default).
   */
  filterUsers?: boolean;
}

/**
 * Get-CsOnlineUser slices: users split by first UPN character, plus the other
 * account types. Together these cover every account exactly once (the "other
 * users" bucket mops up UPNs that start with something odd). Each call is a
 * small fraction of the tenant, so the fetch phase shows real progress and no
 * single call can time out on a big tenant.
 *
 * By default only the Teams-voice migration candidates are fetched: enabled
 * `User` accounts, resource accounts, SfB-on-prem users. Guests, disabled and
 * unlicensed accounts (and the invalid "ApplicationEndpoint" type) are left out
 * unless the engineer opts in. Valid AccountType enum: User, ResourceAccount,
 * Guest, SfbOnPremUser, Unknown, IneligibleUser.
 */
const UPN_FIRST = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const userBuckets = (opts: DiscoveryFilterOpts = {}): { label: string; filter: string }[] => {
  // `-Filter` is rendered inside a double-quoted PS string, so escape the $ in
  // $true (`$true) to stop pwsh interpolating it to the word "True".
  const enabled = opts.includeDisabled ? '' : ' -and AccountEnabled -eq `$true';
  const out = UPN_FIRST.map((c) => ({
    label: `users ${c}*`,
    filter: `AccountType -eq 'User'${enabled} -and UserPrincipalName -like '${c}*'`,
  }));
  const notAny = UPN_FIRST.map((c) => `UserPrincipalName -notlike '${c}*'`).join(' -and ');
  out.push({
    label: 'users (other)',
    filter: `AccountType -eq 'User'${enabled} -and ${notAny}`,
  });
  // always relevant, regardless of enabled/licence state
  for (const t of ['ResourceAccount', 'SfbOnPremUser', 'Unknown']) {
    out.push({ label: t, filter: `AccountType -eq '${t}'` });
  }
  // only when the engineer opts in - these are never Teams-voice candidates
  if (opts.includeUnlicensed) {
    for (const t of ['Guest', 'IneligibleUser']) {
      out.push({ label: t, filter: `AccountType -eq '${t}'` });
    }
  }
  return out;
};

/**
 * The `Get-CsOnlineUser` properties Discovery actually stores (see `projectUser`
 * in run.ts) plus a few useful extras. Selecting these turns a ~100-property,
 * deeply-nested per-user object into a small one, so a full pull on a large
 * tenant serialises in seconds instead of timing out. Unknown names are
 * harmless - `Select-Object` just yields $null for them.
 */
const USER_PROPERTIES: readonly string[] = [
  'Identity',
  'UserPrincipalName',
  'DisplayName',
  'AccountType',
  'AccountEnabled',
  'EnterpriseVoiceEnabled',
  'LineUri',
  'LineURI',
  'OnPremLineURI',
  'TelephoneNumbers',
  'FeatureTypes',
  'AssignedPlan',
  'UsageLocation',
  'Department',
  'Title',
  'JobTitle',
  'InterpretedUserType',
  'EffectivePolicyAssignments',
  'WhenChanged',
  'WhenCreated',
  'SipAddress',
  'Alias',
  'City',
  'CompanyName',
  'HostingProvider',
  // every policy assignment we project
  ...TENANT_POLICY_TYPES,
];

const s = (v: unknown): string | null =>
  v == null ? null : typeof v === 'string' ? v : typeof v === 'object' && 'Id' in (v as Rec) ? String((v as Rec).Id) : String(v);

/** "Tag:Sales" -> "Sales"; "Global" stays. */
export const policyName = (identity: string | null) =>
  identity == null ? null : identity.replace(/^Tag:/i, '');

/** Get-CsOnlineUser policy fields can be a string or {Name, Authority} - normalise to the name. */
export const policyValue = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return policyName(v);
  if (typeof v === 'object') {
    const o = v as Rec;
    if (typeof o.Name === 'string') return policyName(o.Name);
    if (typeof o.Identity === 'string') return policyName(o.Identity);
  }
  return null;
};

export const STEP_CMDLETS: Record<TenantDiscoveryStep, CmdletSpec[]> = {
  tenant: [
    {
      command: 'Get-CsTenant',
      objectType: 'tenant',
      key: (r) => s(r.TenantId) ?? s(r.Identity),
      name: (r) => s(r.DisplayName),
    },
  ],
  users: [
    {
      // All account types (users, resource accounts, guests, ineligible) - the
      // AccountType field tells them apart and the UI filters. Narrowed to the
      // properties we store and given a long leash: this is the one call that
      // can run for many minutes on a big tenant.
      command: 'Get-CsOnlineUser',
      objectType: 'user',
      key: (r) => s(r.Identity) ?? s(r.UserPrincipalName),
      name: (r) => s(r.DisplayName),
      resultSize: 100000,
      select: USER_PROPERTIES,
      // array > user > AssignedPlan > plan > {Capability,CapabilityStatus} is
      // four levels deep - serialise a couple deeper so the licence fields the
      // user filter reads are never truncated to a type-name string.
      depth: 6,
      timeoutMs: 15 * 60_000,
      buckets: userBuckets,
    },
  ],
  resource_accounts: [
    {
      command: 'Get-CsOnlineApplicationInstance',
      objectType: 'resource_account',
      key: (r) => s(r.ObjectId) ?? s(r.UserPrincipalName),
      name: (r) => s(r.DisplayName),
    },
  ],
  numbers: [
    {
      command: 'Get-CsPhoneNumberAssignment',
      objectType: 'phone_number',
      key: (r) => s(r.TelephoneNumber),
      name: (r) => s(r.TelephoneNumber),
      page: { size: 500, style: 'top-skip' },
    },
  ],
  policies: TENANT_POLICY_TYPES.map<CmdletSpec>((type) => ({
    command: `Get-Cs${type}`,
    objectType: 'policy',
    policyType: type,
    key: (r) => {
      const id = s(r.Identity);
      return id ? `${type}:${id}` : null;
    },
    name: (r) => policyName(s(r.Identity)),
  })),
  voice_routing: [
    {
      command: 'Get-CsOnlinePSTNGateway',
      objectType: 'pstn_gateway',
      key: (r) => s(r.Identity) ?? s(r.Fqdn),
      name: (r) => s(r.Fqdn) ?? s(r.Identity),
    },
    {
      // one record holding Usage: [...] - emit one object per usage
      command: 'Get-CsOnlinePstnUsage',
      objectType: 'pstn_usage',
      key: (r) => s(r.Usage),
      name: (r) => s(r.Usage),
      explode: (r) =>
        Array.isArray(r.Usage) ? (r.Usage as unknown[]).map((u) => ({ Usage: u, Identity: r.Identity })) : [r],
    },
    {
      command: 'Get-CsOnlineVoiceRoute',
      objectType: 'voice_route',
      key: (r) => s(r.Identity),
      name: (r) => s(r.Name) ?? s(r.Identity),
    },
  ],
  emergency: [
    {
      command: 'Get-CsOnlineLisLocation',
      objectType: 'emergency_location',
      key: (r) => s(r.LocationId),
      name: (r) => s(r.Location) ?? s(r.Description) ?? s(r.CompanyName),
    },
    {
      command: 'Get-CsOnlineLisCivicAddress',
      objectType: 'civic_address',
      key: (r) => s(r.CivicAddressId),
      name: (r) =>
        s(r.Description) ??
        [r.HouseNumber, r.StreetName, r.City].filter(Boolean).map(String).join(' ') ??
        null,
    },
  ],
  voice_apps: [
    {
      command: 'Get-CsAutoAttendant',
      objectType: 'auto_attendant',
      key: (r) => s(r.Identity),
      name: (r) => s(r.Name),
      page: { size: 100, style: 'first-skip' },
    },
    {
      command: 'Get-CsCallQueue',
      objectType: 'call_queue',
      key: (r) => s(r.Identity),
      name: (r) => s(r.Name),
      page: { size: 100, style: 'first-skip' },
    },
    {
      command: 'Get-CsOnlineSchedule',
      objectType: 'schedule',
      key: (r) => s(r.Id) ?? s(r.Identity),
      name: (r) => s(r.Name),
    },
  ],
};

/** Object types a step owns - used to tombstone objects that vanished after a successful step. */
export const STEP_TYPES: Record<TenantDiscoveryStep, TenantObjectType[]> = Object.fromEntries(
  (Object.keys(STEP_CMDLETS) as TenantDiscoveryStep[]).map((st) => [
    st,
    Array.from(new Set(STEP_CMDLETS[st].map((c) => c.objectType))),
  ]),
) as Record<TenantDiscoveryStep, TenantObjectType[]>;
