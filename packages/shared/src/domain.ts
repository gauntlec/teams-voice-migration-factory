/**
 * Domain value lists lifted from the current build workbook
 * (ATTC MS Teams Build 5.3.xlsx) and the migration PowerShell script.
 * Shared by the API, the worker and the web forms so options never drift.
 */

export const MODULES = [
  'data-collection',
  'build',
  'deployment',
  'handover',
] as const;
export type ModuleId = (typeof MODULES)[number];

/* --------------------------- Data Collection --------------------------- */

export const DISCOVERY_STATUSES = ['draft', 'submitted', 'accepted'] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/** How the customer will get PSTN connectivity - drives the build later. */
export const LICENSING_MODELS = [
  'CallingPlan',
  'OperatorConnect',
  'DirectRouting',
  'Mixed',
] as const;
export type LicensingModel = (typeof LICENSING_MODELS)[number];

/** Delivery region for a site (per-site overview). */
export const SITE_REGIONS = ['AMER', 'EMEA', 'APAC'] as const;
export type SiteRegion = (typeof SITE_REGIONS)[number];

/** discovery_number_ranges.kind */
export const NUMBER_RANGE_KINDS = ['new', 'port', 'retain'] as const;
export type NumberRangeKind = (typeof NUMBER_RANGE_KINDS)[number];

/** discovery_network.scope / network_type */
export const NETWORK_SCOPES = ['internal', 'external'] as const;
export const NETWORK_TYPES = ['LAN', 'WLAN'] as const;

/**
 * discovery_network.location - the subnet's role on the site. Drives the network
 * diagram on the Network (E911) tab.
 */
export const NETWORK_LOCATIONS = [
  'External Subnet',
  'User VLAN',
  'Voice/VOIP VLAN',
  'Wireless VLAN',
] as const;
export type NetworkLocation = (typeof NETWORK_LOCATIONS)[number];

/** discovery_flows.kind - narrative descriptions of existing call routing */
export const FLOW_KINDS = ['auto_attendant', 'call_queue', 'other'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

/* -- Telephony discovery (per the ATTC Telephony Discovery Template) -- */

/** Every phone number belongs to exactly one holder (or none, while free). */
export const NUMBER_HOLDER_TYPES = ['user', 'cap', 'resource_account', 'analogue'] as const;
export type NumberHolderType = (typeof NUMBER_HOLDER_TYPES)[number];

export const NUMBER_STATUSES = ['available', 'reserved', 'assigned'] as const;
export type NumberStatus = (typeof NUMBER_STATUSES)[number];

/** Users / CAPs / analogue devices: how outbound caller ID is presented. */
export const CALLER_ID_OPTIONS = ['user', 'anonymous', 'main_number'] as const;
export type CallerIdOption = (typeof CALLER_ID_OPTIONS)[number];

/** discovery_resource_accounts.kind (the "Virtual Numbers" tab). */
export const RESOURCE_ACCOUNT_KINDS = ['auto_attendant', 'call_queue'] as const;
export type ResourceAccountKind = (typeof RESOURCE_ACCOUNT_KINDS)[number];

/**
 * Microsoft's well-known, tenant-independent ApplicationId values for
 * New-CsOnlineApplicationInstance - not a secret, documented by Microsoft for
 * every tenant. Confirmed against the real Teams-Migration-Build.ps1 script.
 */
export const RESOURCE_ACCOUNT_APPLICATION_IDS: Record<ResourceAccountKind, string> = {
  auto_attendant: 'ce933385-9390-45d1-9512-c8d228074e07',
  call_queue: '11cd3e2e-fccb-42ad-ad00-878b93575e07',
};

/** Max numbers a single range may generate into the inventory. */
export const MAX_RANGE_SIZE = 5000;

/** Shape stored in discovery.general (jsonb) - legacy customer-level overview. */
export interface DiscoveryGeneral {
  migrationId?: string;
  region?: string;
  author?: string;
  licensingModel?: LicensingModel | '';
  targetGoLive?: string;
  primaryContactEmail?: string;
  notes?: string;
}

/**
 * Shape stored in discovery_sites.overview (jsonb). The overview moved from the
 * customer to each site; `assignedUserIds` are the ENGINEER / PROJECT_MANAGER
 * platform users watching this site. Editable only by SUPER_ADMIN /
 * PROJECT_MANAGER / ENGINEER (`discovery:sites:manage`).
 */
export interface DiscoverySiteOverview extends DiscoveryGeneral {
  assignedUserIds?: string[];
  /** Days between number-port document reminder emails for this site (default 7). See number_port_requests. */
  portDocReminderDays?: number;
}

/**
 * Set-CsPhoneNumberAssignment -PhoneNumberType. Only these three are valid
 * values for that parameter (Microsoft Learn) - Shared Calling users don't
 * get a phone number assigned at all (they get EnterpriseVoiceEnabled set
 * directly instead, plus the shared_calling_policy grant - see
 * planIdentityRow in deployment.ts), so 'SharedCalling' was never a real
 * PhoneNumberType and has been removed.
 */
export const NUMBER_TYPES = ['DirectRouting', 'CallingPlan', 'OperatorConnect'] as const;
export type NumberType = (typeof NUMBER_TYPES)[number];

/** Grant-Cs*Policy families the build sheet assigns per user / CAP. */
export const POLICY_KINDS = [
  { key: 'voice_routing_policy', label: 'Voice Routing Policy', cmdlet: 'Grant-CsOnlineVoiceRoutingPolicy' },
  { key: 'dial_out_policy', label: 'Dial Out Policy', cmdlet: 'Grant-CsDialoutPolicy' },
  { key: 'shared_calling_policy', label: 'Shared Calling Policy', cmdlet: 'Grant-CsTeamsSharedCallingRoutingPolicy' },
  { key: 'dial_plan', label: 'Tenant Dial Plan', cmdlet: 'Grant-CsTenantDialPlan' },
  { key: 'calling_policy', label: 'Teams Calling Policy', cmdlet: 'Grant-CsTeamsCallingPolicy' },
  { key: 'call_hold_policy', label: 'Call Hold Policy', cmdlet: 'Grant-CsTeamsCallHoldPolicy' },
  { key: 'call_park_policy', label: 'Call Park Policy', cmdlet: 'Grant-CsTeamsCallParkPolicy' },
  { key: 'caller_id_policy', label: 'Caller ID Policy', cmdlet: 'Grant-CsCallingLineIdentity' },
  { key: 'voice_app_policy', label: 'Voice Application Policy', cmdlet: 'Grant-CsTeamsVoiceApplicationsPolicy' },
  { key: 'voicemail_policy', label: 'Voicemail Policy', cmdlet: 'Grant-CsOnlineVoicemailPolicy' },
  { key: 'emergency_calling_policy', label: 'Emergency Calling Policy', cmdlet: 'Grant-CsTeamsEmergencyCallingPolicy' },
  { key: 'emergency_call_routing_policy', label: 'Emergency Call Routing Policy', cmdlet: 'Grant-CsTeamsEmergencyCallRoutingPolicy' },
  { key: 'ip_phone_policy', label: 'IP Phone Policy', cmdlet: 'Grant-CsTeamsIPPhonePolicy' },
] as const;
export type PolicyKey = (typeof POLICY_KINDS)[number]['key'];

/**
 * Maps a build-side PolicyKey to the TenantPolicyType Discovery projects onto
 * `tenant_users.policies` (see run.ts `projectUser`, keyed by TENANT_POLICY_TYPES),
 * so Design & Build can compare a target policy against the tenant's live state.
 * Every kind is covered. Dial Out is the naming oddity: the grant cmdlet is
 * `Grant-CsDialoutPolicy` (POLICY_KINDS) but the module exposes the
 * assignment as the `OnlineDialOutPolicy` user property and lists the tenant's
 * policies via `Get-CsOnlineDialOutPolicy` - hence that TenantPolicyType.
 */
export const POLICY_KIND_TO_TENANT_TYPE: Partial<Record<PolicyKey, TenantPolicyType>> = {
  voice_routing_policy: 'OnlineVoiceRoutingPolicy',
  dial_out_policy: 'OnlineDialOutPolicy',
  shared_calling_policy: 'TeamsSharedCallingRoutingPolicy',
  dial_plan: 'TenantDialPlan',
  calling_policy: 'TeamsCallingPolicy',
  call_hold_policy: 'TeamsCallHoldPolicy',
  call_park_policy: 'TeamsCallParkPolicy',
  caller_id_policy: 'CallingLineIdentity',
  voice_app_policy: 'TeamsVoiceApplicationsPolicy',
  voicemail_policy: 'OnlineVoicemailPolicy',
  emergency_calling_policy: 'TeamsEmergencyCallingPolicy',
  emergency_call_routing_policy: 'TeamsEmergencyCallRoutingPolicy',
  ip_phone_policy: 'TeamsIPPhonePolicy',
};

/**
 * Voicemail prompt languages Teams accepts for
 * `Set-CsOnlineVoicemailUserSettings -PromptLanguage` - culture codes, not
 * names ("English" is rejected). This is the picker list everywhere a
 * voicemail language is entered (Data Collection, Excel import, Design &
 * Build), so what's stored is always deployable as-is.
 */
export const VOICEMAIL_PROMPT_LANGUAGES = [
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-CA', label: 'English (Canada)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'fr-FR', label: 'French (France)' },
  { code: 'fr-CA', label: 'French (Canada)' },
  { code: 'de-DE', label: 'German' },
  { code: 'es-ES', label: 'Spanish (Spain)' },
  { code: 'es-MX', label: 'Spanish (Mexico)' },
  { code: 'it-IT', label: 'Italian' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'nl-NL', label: 'Dutch (Netherlands)' },
  { code: 'nl-BE', label: 'Dutch (Belgium)' },
  { code: 'sv-SE', label: 'Swedish' },
  { code: 'da-DK', label: 'Danish' },
  { code: 'nb-NO', label: 'Norwegian' },
  { code: 'fi-FI', label: 'Finnish' },
  { code: 'pl-PL', label: 'Polish' },
  { code: 'cs-CZ', label: 'Czech' },
  { code: 'sk-SK', label: 'Slovak' },
  { code: 'hu-HU', label: 'Hungarian' },
  { code: 'ro-RO', label: 'Romanian' },
  { code: 'el-GR', label: 'Greek' },
  { code: 'tr-TR', label: 'Turkish' },
  { code: 'ru-RU', label: 'Russian' },
  { code: 'he-IL', label: 'Hebrew' },
  { code: 'ar-EG', label: 'Arabic' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'th-TH', label: 'Thai' },
  { code: 'vi-VN', label: 'Vietnamese' },
  { code: 'id-ID', label: 'Indonesian' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'ko-KR', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Traditional)' },
  { code: 'zh-HK', label: 'Chinese (Hong Kong)' },
] as const;
export type VoicemailPromptLanguage = (typeof VOICEMAIL_PROMPT_LANGUAGES)[number]['code'];
export const VOICEMAIL_PROMPT_LANGUAGE_CODES = VOICEMAIL_PROMPT_LANGUAGES.map((l) => l.code) as [
  VoicemailPromptLanguage,
  ...VoicemailPromptLanguage[],
];

/**
 * Every language New-CsAutoAttendant/Set-CsAutoAttendant -LanguageId accepts,
 * confirmed against Microsoft's own Auto Attendant supported-languages
 * reference (learn.microsoft.com/microsoftteams/aa-cq-setup-auto-attendant-languages).
 * `speechInput: false` means Microsoft's own docs note that language has no
 * speech recognition - dial-by-name falls back to keypad-only and the "voice
 * input" menu option is unavailable, same caveat the docs call out.
 */
export const AA_SUPPORTED_LANGUAGES = [
  { code: 'ar-EG', label: 'Arabic (Egypt)', speechInput: false },
  { code: 'ar-SA', label: 'Arabic (Saudi Arabia)', speechInput: false },
  { code: 'bg-BG', label: 'Bulgarian (Bulgaria)', speechInput: false },
  { code: 'ca-ES', label: 'Catalan (Spain)', speechInput: false },
  { code: 'zh-CN', label: 'Chinese (Simplified, PRC)', speechInput: true },
  { code: 'zh-HK', label: 'Chinese (Traditional, Hong Kong SAR)', speechInput: false },
  { code: 'zh-TW', label: 'Chinese (Traditional, Taiwan)', speechInput: false },
  { code: 'hr-HR', label: 'Croatian (Croatia)', speechInput: false },
  { code: 'cs-CZ', label: 'Czech (Czech Republic)', speechInput: false },
  { code: 'da-DK', label: 'Danish (Denmark)', speechInput: false },
  { code: 'da-BE', label: 'Danish (Belgium)', speechInput: false },
  { code: 'nl-NL', label: 'Dutch (Netherlands)', speechInput: false },
  { code: 'en-AU', label: 'English (Australia)', speechInput: true },
  { code: 'en-CA', label: 'English (Canada)', speechInput: true },
  { code: 'en-IN', label: 'English (India)', speechInput: true },
  { code: 'en-IE', label: 'English (Ireland)', speechInput: false },
  { code: 'en-PH', label: 'English (Philippines)', speechInput: false },
  { code: 'en-ZA', label: 'English (South Africa)', speechInput: false },
  { code: 'en-GB', label: 'English (United Kingdom)', speechInput: true },
  { code: 'en-US', label: 'English (United States)', speechInput: true },
  { code: 'et-EE', label: 'Estonian (Estonia)', speechInput: false },
  { code: 'fi-FI', label: 'Finnish (Finland)', speechInput: false },
  { code: 'fr-BE', label: 'French (Belgium)', speechInput: false },
  { code: 'fr-CA', label: 'French (Canada)', speechInput: true },
  { code: 'fr-FR', label: 'French (France)', speechInput: true },
  { code: 'fr-CH', label: 'French (Switzerland)', speechInput: true },
  { code: 'de-AT', label: 'German (Austria)', speechInput: false },
  { code: 'de-DE', label: 'German (Germany)', speechInput: false },
  { code: 'de-CH', label: 'German (Switzerland)', speechInput: false },
  { code: 'el-GR', label: 'Greek (Greece)', speechInput: false },
  { code: 'he-IL', label: 'Hebrew (Israel)', speechInput: false },
  { code: 'hi-IN', label: 'Hindi (India)', speechInput: false },
  { code: 'hu-HU', label: 'Hungarian (Hungary)', speechInput: false },
  { code: 'id-ID', label: 'Indonesian (Indonesia)', speechInput: false },
  { code: 'it-IT', label: 'Italian (Italy)', speechInput: true },
  { code: 'ja-JP', label: 'Japanese (Japan)', speechInput: true },
  { code: 'ko-KR', label: 'Korean (Korea)', speechInput: false },
  { code: 'lv-LV', label: 'Latvian (Latvia)', speechInput: false },
  { code: 'lt-LT', label: 'Lithuanian (Lithuania)', speechInput: false },
  { code: 'nb-NO', label: 'Norwegian Bokmal (Norway)', speechInput: false },
  { code: 'pl-PL', label: 'Polish (Poland)', speechInput: false },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', speechInput: true },
  { code: 'pt-PT', label: 'Portuguese (Portugal)', speechInput: false },
  { code: 'ro-RO', label: 'Romanian (Romania)', speechInput: false },
  { code: 'ru-RU', label: 'Russian (Russia)', speechInput: false },
  { code: 'sk-SK', label: 'Slovak (Slovakia)', speechInput: false },
  { code: 'sl-SI', label: 'Slovenian (Slovenia)', speechInput: false },
  { code: 'es-MX', label: 'Spanish (Mexico)', speechInput: true },
  { code: 'es-ES', label: 'Spanish (Spain, International)', speechInput: true },
  { code: 'sv-SE', label: 'Swedish (Sweden)', speechInput: false },
  { code: 'th-TH', label: 'Thai (Thailand)', speechInput: false },
  { code: 'tr-TR', label: 'Turkish (Türkiye)', speechInput: false },
  { code: 'vi-VN', label: 'Vietnamese (Vietnam)', speechInput: false },
  { code: 'cy-GB', label: 'Welsh (United Kingdom)', speechInput: false },
] as const;
export type AaSupportedLanguage = (typeof AA_SUPPORTED_LANGUAGES)[number]['code'];

/**
 * Every Windows time zone ID New-CsAutoAttendant/Set-CsAutoAttendant
 * -TimeZoneId accepts - the same values Get-CsAutoAttendantSupportedTimeZone
 * returns, ordered by UTC offset. Confirmed against Microsoft's own Windows
 * default-timezone reference (learn.microsoft.com/windows-hardware/manufacture/desktop/default-time-zones).
 */
export const AA_TIME_ZONES = [
  { id: 'Dateline Standard Time', label: '(UTC-12:00) International Date Line West' },
  { id: 'UTC-11', label: '(UTC-11:00) Coordinated Universal Time-11' },
  { id: 'Hawaiian Standard Time', label: '(UTC-10:00) Hawaii' },
  { id: 'Alaskan Standard Time', label: '(UTC-09:00) Alaska' },
  { id: 'Pacific Standard Time', label: '(UTC-08:00) Pacific Time (US & Canada)' },
  { id: 'Pacific Standard Time (Mexico)', label: '(UTC-08:00) Baja California' },
  { id: 'Mountain Standard Time', label: '(UTC-07:00) Mountain Time (US & Canada)' },
  { id: 'US Mountain Standard Time', label: '(UTC-07:00) Arizona' },
  { id: 'Central Standard Time', label: '(UTC-06:00) Central Time (US & Canada)' },
  { id: 'Central Standard Time (Mexico)', label: '(UTC-06:00) Guadalajara, Mexico City, Monterrey' },
  { id: 'Central America Standard Time', label: '(UTC-06:00) Central America' },
  { id: 'Eastern Standard Time', label: '(UTC-05:00) Eastern Time (US & Canada)' },
  { id: 'US Eastern Standard Time', label: '(UTC-05:00) Indiana (East)' },
  { id: 'SA Pacific Standard Time', label: '(UTC-05:00) Bogota, Lima, Quito, Rio Branco' },
  { id: 'Venezuela Standard Time', label: '(UTC-04:30) Caracas' },
  { id: 'Atlantic Standard Time', label: '(UTC-04:00) Atlantic Time (Canada)' },
  { id: 'SA Western Standard Time', label: '(UTC-04:00) Georgetown, La Paz, Manaus, San Juan' },
  { id: 'Paraguay Standard Time', label: '(UTC-04:00) Asuncion' },
  { id: 'Newfoundland Standard Time', label: '(UTC-03:30) Newfoundland' },
  { id: 'E. South America Standard Time', label: '(UTC-03:00) Brasilia' },
  { id: 'Argentina Standard Time', label: '(UTC-03:00) City of Buenos Aires' },
  { id: 'SA Eastern Standard Time', label: '(UTC-03:00) Cayenne, Fortaleza' },
  { id: 'Greenland Standard Time', label: '(UTC-03:00) Greenland' },
  { id: 'Montevideo Standard Time', label: '(UTC-03:00) Montevideo' },
  { id: 'Pacific SA Standard Time', label: '(UTC-03:00) Santiago' },
  { id: 'UTC-02', label: '(UTC-02:00) Coordinated Universal Time-02' },
  { id: 'Cape Verde Standard Time', label: '(UTC-01:00) Cabo Verde Is.' },
  { id: 'UTC', label: '(UTC) Coordinated Universal Time' },
  { id: 'GMT Standard Time', label: '(UTC) Dublin, Edinburgh, Lisbon, London' },
  { id: 'Greenwich Standard Time', label: '(UTC) Monrovia, Reykjavik' },
  { id: 'Morocco Standard Time', label: '(UTC) Casablanca' },
  { id: 'W. Europe Standard Time', label: '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna' },
  { id: 'Central Europe Standard Time', label: '(UTC+01:00) Belgrade, Bratislava, Budapest, Ljubljana, Prague' },
  { id: 'Romance Standard Time', label: '(UTC+01:00) Brussels, Copenhagen, Madrid, Paris' },
  { id: 'Central European Standard Time', label: '(UTC+01:00) Sarajevo, Skopje, Warsaw, Zagreb' },
  { id: 'W. Central Africa Standard Time', label: '(UTC+01:00) West Central Africa' },
  { id: 'Namibia Standard Time', label: '(UTC+01:00) Windhoek' },
  { id: 'FLE Standard Time', label: '(UTC+02:00) Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius' },
  { id: 'GTB Standard Time', label: '(UTC+02:00) Athens, Bucharest' },
  { id: 'Middle East Standard Time', label: '(UTC+02:00) Beirut' },
  { id: 'Egypt Standard Time', label: '(UTC+02:00) Cairo' },
  { id: 'E. Europe Standard Time', label: '(UTC+02:00) E. Europe' },
  { id: 'South Africa Standard Time', label: '(UTC+02:00) Harare, Pretoria' },
  { id: 'Israel Standard Time', label: '(UTC+02:00) Jerusalem' },
  { id: 'Jordan Standard Time', label: '(UTC+02:00) Amman' },
  { id: 'Syria Standard Time', label: '(UTC+02:00) Damascus' },
  { id: 'Türkiye Standard Time', label: '(UTC+02:00) Istanbul' },
  { id: 'Arabic Standard Time', label: '(UTC+03:00) Baghdad' },
  { id: 'Arab Standard Time', label: '(UTC+03:00) Kuwait, Riyadh' },
  { id: 'Belarus Standard Time', label: '(UTC+03:00) Minsk' },
  { id: 'Russian Standard Time', label: '(UTC+03:00) Moscow, St. Petersburg, Volgograd' },
  { id: 'E. Africa Standard Time', label: '(UTC+03:00) Nairobi' },
  { id: 'Iran Standard Time', label: '(UTC+03:30) Tehran' },
  { id: 'Arabian Standard Time', label: '(UTC+04:00) Abu Dhabi, Muscat' },
  { id: 'Azerbaijan Standard Time', label: '(UTC+04:00) Baku' },
  { id: 'Caucasus Standard Time', label: '(UTC+04:00) Yerevan' },
  { id: 'Georgian Standard Time', label: '(UTC+04:00) Tbilisi' },
  { id: 'Mauritius Standard Time', label: '(UTC+04:00) Port Louis' },
  { id: 'Afghanistan Standard Time', label: '(UTC+04:30) Kabul' },
  { id: 'West Asia Standard Time', label: '(UTC+05:00) Ashgabat, Tashkent' },
  { id: 'Pakistan Standard Time', label: '(UTC+05:00) Islamabad, Karachi' },
  { id: 'India Standard Time', label: '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi' },
  { id: 'Sri Lanka Standard Time', label: '(UTC+05:30) Sri Jayawardenepura' },
  { id: 'Nepal Standard Time', label: '(UTC+05:45) Kathmandu' },
  { id: 'Central Asia Standard Time', label: '(UTC+06:00) Astana' },
  { id: 'Bangladesh Standard Time', label: '(UTC+06:00) Dhaka' },
  { id: 'Myanmar Standard Time', label: '(UTC+06:30) Yangon (Rangoon)' },
  { id: 'SE Asia Standard Time', label: '(UTC+07:00) Bangkok, Hanoi, Jakarta' },
  { id: 'China Standard Time', label: '(UTC+08:00) Beijing, Chongqing, Hong Kong SAR, Urumqi' },
  { id: 'Singapore Standard Time', label: '(UTC+08:00) Kuala Lumpur, Singapore' },
  { id: 'Taipei Standard Time', label: '(UTC+08:00) Taipei' },
  { id: 'Ulaanbaatar Standard Time', label: '(UTC+08:00) Ulaanbaatar' },
  { id: 'Tokyo Standard Time', label: '(UTC+09:00) Osaka, Sapporo, Tokyo' },
  { id: 'Korea Standard Time', label: '(UTC+09:00) Seoul' },
  { id: 'AUS Eastern Standard Time', label: '(UTC+10:00) Canberra, Melbourne, Sydney' },
  { id: 'West Pacific Standard Time', label: '(UTC+10:00) Guam, Port Moresby' },
  { id: 'Central Pacific Standard Time', label: '(UTC+11:00) Solomon Is., New Caledonia' },
  { id: 'New Zealand Standard Time', label: '(UTC+12:00) Auckland, Wellington' },
  { id: 'UTC+12', label: '(UTC+12:00) Coordinated Universal Time+12' },
  { id: 'Fiji Standard Time', label: '(UTC+12:00) Fiji' },
  { id: 'Tonga Standard Time', label: '(UTC+13:00) Nukuʻalofa' },
  { id: 'Samoa Standard Time', label: '(UTC+13:00) Samoa' },
] as const;
export type AaTimeZone = (typeof AA_TIME_ZONES)[number]['id'];

/**
 * Plain-English names people actually type for a voicemail language, mapped
 * to the culture code Teams wants. Keep in step with the SQL map in
 * packages/db/migrations/tenant/0020_voicemail_language_codes.sql, which
 * converted the values that existed before the picker.
 */
const VOICEMAIL_LANGUAGE_ALIASES: Record<string, VoicemailPromptLanguage> = {
  english: 'en-US',
  'english (us)': 'en-US',
  'english (united states)': 'en-US',
  'us english': 'en-US',
  'american english': 'en-US',
  'english (uk)': 'en-GB',
  'english (united kingdom)': 'en-GB',
  'uk english': 'en-GB',
  'british english': 'en-GB',
  'english (australia)': 'en-AU',
  'english (canada)': 'en-CA',
  'english (india)': 'en-IN',
  french: 'fr-FR',
  'french (france)': 'fr-FR',
  'french (canada)': 'fr-CA',
  german: 'de-DE',
  spanish: 'es-ES',
  'spanish (spain)': 'es-ES',
  'spanish (mexico)': 'es-MX',
  italian: 'it-IT',
  portuguese: 'pt-PT',
  'portuguese (brazil)': 'pt-BR',
  'portuguese (portugal)': 'pt-PT',
  dutch: 'nl-NL',
  swedish: 'sv-SE',
  danish: 'da-DK',
  norwegian: 'nb-NO',
  finnish: 'fi-FI',
  polish: 'pl-PL',
  czech: 'cs-CZ',
  turkish: 'tr-TR',
  russian: 'ru-RU',
  japanese: 'ja-JP',
  korean: 'ko-KR',
  chinese: 'zh-CN',
  'chinese (simplified)': 'zh-CN',
  'chinese (traditional)': 'zh-TW',
};

/**
 * Accepts a culture code in any case/separator ("en-us", "EN_GB") or a common
 * English name ("English (United Kingdom)") and returns the canonical code,
 * or null when it isn't a language Teams voicemail supports.
 */
export function normalizeVoicemailLanguage(v: unknown): VoicemailPromptLanguage | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  const asCode = t.replace('_', '-');
  if (/^[a-z]{2}-[a-z]{2}$/i.test(asCode)) {
    const code = `${asCode.slice(0, 2).toLowerCase()}-${asCode.slice(3, 5).toUpperCase()}`;
    return (VOICEMAIL_PROMPT_LANGUAGE_CODES as readonly string[]).includes(code) ? (code as VoicemailPromptLanguage) : null;
  }
  return VOICEMAIL_LANGUAGE_ALIASES[t.toLowerCase()] ?? null;
}

/**
 * Vocab for Set-CsUserCallingSettings / New-CsUserCallingDelegate, matching
 * the cmdlets' actual accepted values (Microsoft Learn) - see
 * planIdentityRow in deployment.ts and build_users/build_caps'
 * call_forwarding/pickup_group/delegates jsonb columns.
 */
export const CALL_TARGET_TYPES = ['Voicemail', 'SingleTarget', 'MyDelegates', 'Group'] as const;
export const CALL_FORWARDING_TYPES = ['Immediate', 'Simultaneous'] as const;
export const CALL_GROUP_ORDERS = ['Simultaneous', 'InOrder'] as const;
export const BUSY_ON_BUSY_OPTIONS = ['PlayBusySignal', 'RedirectAsUnansweredCall', 'RingUser'] as const;
export const VOICEMAIL_ANSWERING_RULES = ['PromptOnly', 'PromptOnlyWithTransfer', 'RegularVoicemail', 'VoicemailWithTransferOption'] as const;

export const CALL_QUEUE_ROUTING_METHODS = [
  'Attendant',
  'Serial',
  'RoundRobin',
  'LongestIdle',
] as const;

/** Set-CsCallQueue -OverflowAction / -TimeoutAction / -NoAgentAction - see planCallQueueRow in deployment.ts. */
export const CALL_QUEUE_OVERFLOW_ACTIONS = ['DisconnectWithBusy', 'Forward', 'Voicemail', 'SharedVoicemail'] as const;
export const CALL_QUEUE_TIMEOUT_ACTIONS = ['Disconnect', 'Forward', 'Voicemail', 'SharedVoicemail'] as const;
/** NoAgentAction fires when zero agents are opted in - distinct from Overflow (queue full) and Timeout (waited too long). */
export const CALL_QUEUE_NO_AGENT_ACTIONS = ['Queue', 'Disconnect', 'Forward', 'Voicemail', 'SharedVoicemail'] as const;
export const CALL_QUEUE_NO_AGENT_APPLY_TO = ['AllCalls', 'NewCalls'] as const;

export const GREETING_TYPES = ['None', 'Text', 'AudioFile'] as const;

/**
 * Set-CsAutoAttendant's construction chain (New-CsAutoAttendantCallableEntity
 * -> ...Prompt -> ...MenuOption -> ...Menu -> ...CallFlow -> New-CsOnlineSchedule
 * -> ...CallHandlingAssociation -> New-CsAutoAttendant) - see planAutoAttendantRow
 * in deployment.ts and BuildAutoAttendantsTable's structured columns
 * (packages/db/src/schema.ts). Verified against real live OVP012 Auto
 * Attendants and Microsoft Learn's own example scripts this session.
 */

/** New-CsAutoAttendantCallableEntity -Type, plus the app-only 'auto_attendant'/'call_queue' kinds for same-site menu targets (New-CsOnlineApplicationInstanceAssociation links the actual resource account at deploy time, not this reference). */
export const AA_CALLABLE_ENTITY_KINDS = ['auto_attendant', 'call_queue', 'user', 'external', 'voicemail', 'shared_voicemail'] as const;

/**
 * New-CsAutoAttendantMenuOption -Action. Microsoft's own example scripts use
 * both "Disconnect" and "DisconnectCall" inconsistently for the same
 * action - DisconnectCall appears in 3 of 4 published examples, used here;
 * re-confirm against Get-CsAutoAttendantMenuOption's own reference page
 * before relying on this for a live deployment.
 */
export const AA_MENU_OPTION_ACTIONS = ['TransferCallToTarget', 'TransferCallToOperator', 'DisconnectCall'] as const;

/** New-CsAutoAttendantMenuOption -DtmfResponse. 'Automatic' is Teams' sentinel for "no key pressed"/the catch-all option (DtmfResponse:100 in the raw live data). */
export const AA_DTMF_RESPONSES = ['Tone0', 'Tone1', 'Tone2', 'Tone3', 'Tone4', 'Tone5', 'Tone6', 'Tone7', 'Tone8', 'Tone9', 'Automatic'] as const;

/** New-CsAutoAttendantMenu -DirectorySearchMethod. */
export const AA_DIRECTORY_SEARCH_METHODS = ['ByName', 'ByExtension'] as const;

/** New-CsOnlineSchedule -WeeklyRecurrentSchedule / -FixedSchedule. */
export const AA_SCHEDULE_TYPES = ['weekly', 'fixed'] as const;

/** New-CsAutoAttendantCallHandlingAssociation -Type. */
export const AA_CALL_HANDLING_TYPES = ['AfterHours', 'Holiday'] as const;

/** Sections of the Service Hand-Over Pack (from V1.18.docx). */
export const HANDOVER_SECTIONS = [
  { key: 'site_information', title: 'Site Information' },
  { key: 'service_support_model', title: 'Service Support Model' },
  { key: 'phone_numbers', title: 'Phone Numbers' },
  { key: 'teams_users', title: 'Teams Users' },
  { key: 'common_area_phones', title: 'Common Area Phones (CAPS)' },
  { key: 'analogue_phones', title: 'Analogue (SIP) Phones' },
  { key: 'paging', title: "The Site 'Paging' Information" },
  { key: 'auto_attendants', title: 'Auto Attendants' },
  { key: 'call_queues', title: 'Call Queues' },
  { key: 'resource_accounts', title: 'Resource Accounts' },
  { key: 'voicemail_groups', title: 'Voicemail Groups' },
  { key: 'teams_configuration', title: 'MS Teams Configuration Information' },
  { key: 'network_data', title: 'Network Data' },
  { key: 'outstanding_actions', title: 'Outstanding Actions' },
] as const;

export const DEPLOYMENT_MODES = ['dry_run', 'execute'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const DEPLOYMENT_CHANGE_RESULTS = ['applied', 'skipped', 'failed', 'whatif'] as const;
export type DeploymentChangeResult = (typeof DEPLOYMENT_CHANGE_RESULTS)[number];

export const CONNECTION_STATUSES = ['pending', 'active', 'expired', 'closed'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/* ------------------------- Feature requests ------------------------- */

/**
 * Workflow for a feature request, in board order. An admin moves a card to
 * `in_development` as the signal that Claude Code should pick it up; Claude sets
 * it to `deployed` when the change ships. `declined` is the terminal "won't do"
 * state (with a `decision_note`).
 */
export const FEATURE_STATUSES = [
  'new',
  'under_review',
  'scheduled',
  'in_development',
  'deployed',
  'declined',
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  new: 'New',
  under_review: 'Under review',
  scheduled: 'Scheduled',
  in_development: 'In development',
  deployed: 'Deployed',
  declined: 'Declined',
};

export const FEATURE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];

export const FEATURE_PRIORITY_LABELS: Record<FeaturePriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** Which part of the product a request is about — used as a filter/label. */
export const FEATURE_AREAS = [
  'Data Collection',
  'Discovery',
  'Design & Build',
  'Deployment',
  'Service Handover',
  'Users & Access',
  'Email & Notifications',
  'Reporting & Exports',
  'Platform & Infrastructure',
  'Other',
] as const;
export type FeatureArea = (typeof FEATURE_AREAS)[number];

/* ------------------------- Bug reports ------------------------- */

/**
 * Workflow for a bug report, in board order. `confirmed` means a
 * PM/Engineer reproduced it; `fixed` means the code change landed but
 * hasn't shipped yet; `deployed` is the terminal "done" state.
 * `wont_fix`/`duplicate` are terminal "no further action" states (with a
 * `resolution_note`).
 */
export const BUG_STATUSES = [
  'new',
  'confirmed',
  'in_progress',
  'fixed',
  'deployed',
  'wont_fix',
  'duplicate',
] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

export const BUG_STATUS_LABELS: Record<BugStatus, string> = {
  new: 'New',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  fixed: 'Fixed',
  deployed: 'Deployed',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
};

export const BUG_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

export const BUG_SEVERITY_LABELS: Record<BugSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/* ------------------ Discovery (live customer-tenant inventory) ------------------ */

/**
 * The ordered steps of a tenant discovery run. The worker drives the
 * MicrosoftTeams PowerShell module through these in order; the UI shows them as
 * a progress list. See docs/DISCOVERY.md.
 */
export const TENANT_DISCOVERY_STEPS = [
  'tenant',
  'users',
  'resource_accounts',
  'numbers',
  'policies',
  'voice_routing',
  'emergency',
  'voice_apps',
] as const;
export type TenantDiscoveryStep = (typeof TENANT_DISCOVERY_STEPS)[number];

export const TENANT_DISCOVERY_STEP_LABELS: Record<TenantDiscoveryStep, string> = {
  tenant: 'Tenant',
  users: 'Users',
  resource_accounts: 'Resource accounts',
  numbers: 'Phone numbers',
  policies: 'Policies',
  voice_routing: 'Voice routing',
  emergency: 'Emergency locations',
  voice_apps: 'Auto attendants & call queues',
};

/**
 * The object types each step produces. Lets a run be scoped to part of the
 * tenant (a whole step, or individual types within it) and the UI render the
 * pick-list. The worker filters `STEP_CMDLETS` against the requested types.
 */
export const TENANT_DISCOVERY_STEP_TYPES: Record<TenantDiscoveryStep, readonly TenantObjectType[]> = {
  tenant: ['tenant'],
  users: ['user'],
  resource_accounts: ['resource_account'],
  numbers: ['phone_number'],
  policies: ['policy'],
  voice_routing: ['pstn_gateway', 'pstn_usage', 'voice_route'],
  emergency: ['emergency_location', 'civic_address'],
  voice_apps: ['auto_attendant', 'call_queue', 'schedule'],
};

/** The step a given object type belongs to (inverse of `TENANT_DISCOVERY_STEP_TYPES`). */
export const TENANT_OBJECT_TYPE_STEP = Object.fromEntries(
  (Object.keys(TENANT_DISCOVERY_STEP_TYPES) as TenantDiscoveryStep[]).flatMap((step) =>
    TENANT_DISCOVERY_STEP_TYPES[step].map((t) => [t, step] as const),
  ),
) as Record<TenantObjectType, TenantDiscoveryStep>;

export const TENANT_DISCOVERY_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type TenantDiscoveryRunStatus = (typeof TENANT_DISCOVERY_RUN_STATUSES)[number];

/**
 * How a discovered object changed between two runs. `readded` = an object that
 * was tombstoned (gone from the tenant) and has come back.
 */
export const TENANT_OBJECT_CHANGE_KINDS = ['added', 'updated', 'removed', 'readded'] as const;
export type TenantObjectChangeKind = (typeof TENANT_OBJECT_CHANGE_KINDS)[number];

export const TENANT_OBJECT_CHANGE_KIND_LABELS: Record<TenantObjectChangeKind, string> = {
  added: 'Added',
  updated: 'Changed',
  removed: 'Removed',
  readded: 'Re-added',
};

/** Every kind of object a discovery stores in `tenant_objects`. */
export const TENANT_OBJECT_TYPES = [
  'tenant',
  'user',
  'resource_account',
  'phone_number',
  'policy',
  'pstn_usage',
  'voice_route',
  'pstn_gateway',
  'emergency_location',
  'civic_address',
  'auto_attendant',
  'call_queue',
  'schedule',
] as const;
export type TenantObjectType = (typeof TENANT_OBJECT_TYPES)[number];

export const TENANT_OBJECT_TYPE_LABELS: Record<TenantObjectType, string> = {
  tenant: 'Tenant',
  user: 'Users',
  resource_account: 'Resource accounts',
  phone_number: 'Phone numbers',
  policy: 'Policies',
  pstn_usage: 'PSTN usages',
  voice_route: 'Voice routes',
  pstn_gateway: 'PSTN gateways',
  emergency_location: 'Emergency locations',
  civic_address: 'Civic addresses',
  auto_attendant: 'Auto attendants',
  call_queue: 'Call queues',
  schedule: 'Schedules',
};

/**
 * Teams policy types discovered (one `Get-Cs<Type>` cmdlet each). The value is
 * the PowerShell noun; the worker maps it to the cmdlet. Kept here so Design &
 * Build pickers can ask for "all TeamsCallingPolicy" by a stable key.
 */
export const TENANT_POLICY_TYPES = [
  'TeamsCallingPolicy',
  'OnlineVoiceRoutingPolicy',
  'TenantDialPlan',
  'TeamsEmergencyCallingPolicy',
  'TeamsEmergencyCallRoutingPolicy',
  'OnlineVoicemailPolicy',
  'CallingLineIdentity',
  'TeamsCallParkPolicy',
  'TeamsCallHoldPolicy',
  'TeamsIPPhonePolicy',
  'TeamsSharedCallingRoutingPolicy',
  'TeamsVoiceApplicationsPolicy',
  'OnlineDialOutPolicy',
  'TeamsMeetingPolicy',
  'TeamsMessagingPolicy',
  'TeamsAppSetupPolicy',
] as const;
export type TenantPolicyType = (typeof TENANT_POLICY_TYPES)[number];

export const TENANT_POLICY_TYPE_LABELS: Record<TenantPolicyType, string> = {
  TeamsCallingPolicy: 'Calling policy',
  OnlineVoiceRoutingPolicy: 'Voice routing policy',
  TenantDialPlan: 'Dial plan',
  TeamsEmergencyCallingPolicy: 'Emergency calling policy',
  TeamsEmergencyCallRoutingPolicy: 'Emergency call routing policy',
  OnlineVoicemailPolicy: 'Voicemail policy',
  CallingLineIdentity: 'Caller ID policy',
  TeamsCallParkPolicy: 'Call park policy',
  TeamsCallHoldPolicy: 'Call hold policy',
  TeamsIPPhonePolicy: 'IP phone policy',
  TeamsSharedCallingRoutingPolicy: 'Shared calling routing policy',
  TeamsVoiceApplicationsPolicy: 'Voice applications policy',
  OnlineDialOutPolicy: 'Dial out policy',
  TeamsMeetingPolicy: 'Meeting policy',
  TeamsMessagingPolicy: 'Messaging policy',
  TeamsAppSetupPolicy: 'App setup policy',
};
