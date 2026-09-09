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
}

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
      // AccountType field tells them apart and the UI filters.
      command: 'Get-CsOnlineUser',
      objectType: 'user',
      key: (r) => s(r.Identity) ?? s(r.UserPrincipalName),
      name: (r) => s(r.DisplayName),
      resultSize: 100000,
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
