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
}

/** Set-CsPhoneNumberAssignment -PhoneNumberType */
export const NUMBER_TYPES = [
  'DirectRouting',
  'CallingPlan',
  'OperatorConnect',
  'SharedCalling',
] as const;
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

export const CALL_FORWARDING_TYPES = ['Off', 'Immediate', 'Simultaneous'] as const;
export const CALL_FORWARD_TARGET_TYPES = ['Voicemail', 'SingleTarget', 'Delegates', 'MyDelegates'] as const;
export const VOICEMAIL_ANSWERING_RULES = ['PromptOnly', 'PromptOnlyWithTransfer', 'RegularVoicemail', 'VoicemailWithTransferOption'] as const;

export const CALL_QUEUE_ROUTING_METHODS = [
  'Attendant',
  'Serial',
  'RoundRobin',
  'LongestIdle',
] as const;

export const GREETING_TYPES = ['None', 'Text', 'AudioFile'] as const;

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
