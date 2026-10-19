/**
 * Contracts for the email communication module. The API enqueues a message by
 * `template` + `context`; the worker owns rendering (branded HTML) and delivery.
 * Add a new kind of email by adding a name here and a renderer in
 * `apps/worker/src/mail/templates.ts`.
 */

export const EMAIL_TEMPLATES = [
  'user_invitation',
  'discovery_completed',
  'deployment_completed',
  'port_documents_requested',
  'port_documents_reminder',
  'port_documents_completed',
  'feature_request_status_changed',
  'bug_report_status_changed',
  'service_request_created',
  'service_request_status_changed',
  'service_request_message',
  'service_request_activity',
  'incident_created',
  'incident_status_changed',
  'incident_message',
  'incident_resolved',
  'incident_activity',
  'incident_major',
  'incident_review',
  'mail_test',
  'sso_admin_signin',
  'sso_staff_access_request',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export const EMAIL_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Context for the `user_invitation` template. */
export interface UserInvitationContext {
  displayName: string;
  /** email of the admin/engineer who created the account */
  inviterEmail: string;
  role: string;
  /** customer names the user was granted access to (may be empty) */
  tenantNames: string[];
  /**
   * One-time password the recipient signs in with. Only ever in memory, to render the email: what is stored in
   * `platform.email_messages.context` is `tempPasswordEnc` (encrypted), removed once the message has been handled.
   */
  tempPassword: string;
  /** absolute URL of the web app sign-in page */
  signInUrl: string;
}

/** Context for the `discovery_completed` template (sent by the worker when a
 * tenant-discovery run reaches a terminal state). */
export interface DiscoveryCompletedContext {
  /** display name of the person who started the run */
  recipientName: string;
  /** customer / tenant name */
  customerName: string;
  outcome: 'completed' | 'completed_with_errors' | 'failed';
  /** "Full discovery" or "Partial: users, policies" */
  scopeLabel: string;
  /** human duration, e.g. "4 min 12 s" */
  durationText: string;
  /** objects in the snapshot after this run */
  totalObjects: number;
  added: number;
  updated: number;
  removed: number;
  readded: number;
  /** User accounts left out because they are not licensed for Teams */
  skippedNotLicensed: number;
  /** non-fatal step errors */
  errorCount: number;
  /** set when the run could not read licence data and skipped the user filter */
  filterNote?: string | null;
  /** set when the run failed / lost the sign-in */
  errorMessage?: string | null;
  /** biggest object types this run stored, for a quick breakdown */
  breakdown: { label: string; count: number }[];
  /** absolute URL of the Discovery page */
  runUrl: string;
}

/**
 * Context for the `deployment_completed` template (sent by the worker when a
 * deployment run - What-If or Execute - reaches a terminal state). Unlike
 * discovery, a deployment's own `status` only tracks whether the pwsh
 * session finished, not whether the individual cmdlets inside it succeeded -
 * `outcome` here is derived from `failed` so a 100%-failed run doesn't read
 * as a plain success (the same gap the Deployment page's own badges had).
 */
export interface DeploymentCompletedContext {
  /** display name of the person who ran the deployment */
  recipientName: string;
  customerName: string;
  siteName: string;
  sitecode: string;
  mode: 'dry_run' | 'execute';
  outcome: 'completed' | 'completed_with_errors' | 'failed';
  /** human duration, e.g. "4 min 12 s" */
  durationText: string;
  total: number;
  applied: number;
  whatif: number;
  skipped: number;
  failed: number;
  /** one entry per failed cmdlet, with its own error text - the reason for this email existing at all. */
  failures: { object: string; cmdlet: string; message: string }[];
  /** set when the run itself didn't finish (e.g. lost the tenant sign-in) */
  errorMessage?: string | null;
  /** absolute URL of this site's Deployment page */
  runUrl: string;
}

/**
 * Context shared by the three number-port document emails (requested,
 * reminder, completed) - one row per outstanding/required document.
 */
export interface PortDocumentItemSummary {
  label: string;
  note?: string | null;
  status: 'pending' | 'uploaded' | 'rejected' | 'waived';
  rejectReason?: string | null;
}

interface PortDocumentsBaseContext {
  customerName: string;
  siteName: string;
  sitecode: string;
  rangeLabel: string;
  items: PortDocumentItemSummary[];
  /** absolute URL of the customer-facing Number Porting page */
  portalUrl: string;
}

/** Context for `port_documents_requested` - sent to the customer when PM/Engineer submits the checklist. */
export type PortDocumentsRequestedContext = PortDocumentsBaseContext;

/** Context for `port_documents_reminder` - periodic nudge while items are still outstanding. */
export type PortDocumentsReminderContext = PortDocumentsBaseContext;

/** Context for `port_documents_completed` - sent to whoever submitted the request, once every item clears. */
export interface PortDocumentsCompletedContext {
  recipientName: string;
  customerName: string;
  siteName: string;
  sitecode: string;
  rangeLabel: string;
  runUrl: string;
}

/**
 * Sent to whoever submitted a feature request / logged a bug report, each
 * time a SUPER_ADMIN moves its status - the "action taken" moment. Fired
 * once per status change, not on every edit (see FeatureRequestsService /
 * BugReportsService `update()` for the trigger condition).
 */
export interface FeatureRequestStatusChangedContext {
  title: string;
  area: string;
  fromStatus: import('./domain').FeatureStatus;
  toStatus: import('./domain').FeatureStatus;
  decisionNote?: string | null;
  /** absolute URL of the Feature Requests board */
  runUrl: string;
}

export interface BugReportStatusChangedContext {
  title: string;
  area: string;
  fromStatus: import('./domain').BugStatus;
  toStatus: import('./domain').BugStatus;
  resolutionNote?: string | null;
  /** absolute URL of the Bug Reports board */
  runUrl: string;
}

/** To the engineers and admins on a customer when a service request is raised. */
export interface ServiceRequestCreatedContext {
  customerName: string;
  /** e.g. SR-0042 */
  reference: string;
  title: string;
  typeLabel: string;
  siteLabel: string | null;
  priority: string;
  requestedBy: string;
  /** label/value pairs from the request form */
  lines: { label: string; value: string }[];
  runUrl: string;
}

/** To the person who raised a request, when it is planned, built, deployed or cancelled. */
export interface ServiceRequestStatusChangedContext {
  customerName: string;
  reference: string;
  title: string;
  typeLabel: string;
  fromStatus: import('./service-requests').SrStatus;
  toStatus: import('./service-requests').SrStatus;
  /** How it moved; a reopen or decline reads differently from a step forward. Older messages have none. */
  moveKind?: import('./service-requests').SrMoveKind;
  note?: string | null;
  runUrl: string;
}

/**
 * To the person who raised a request: the team wrote to them.
 *  comment  - a reply on the request
 *  question - the team needs something before it can carry on (waiting on the customer)
 *  reminder - the question is still unanswered (worker, every few days)
 */
export interface ServiceRequestMessageContext {
  customerName: string;
  reference: string;
  title: string;
  typeLabel: string;
  kind: 'comment' | 'question' | 'reminder';
  author: string;
  body: string;
  runUrl: string;
}

/**
 * To the team (the assignee, or every engineer and Super Admin on the customer
 * when nobody is assigned): something happened on a request they need to see.
 */
export interface ServiceRequestActivityContext {
  customerName: string;
  reference: string;
  title: string;
  typeLabel: string;
  kind:
    | 'comment' // the customer commented
    | 'replied' // the customer answered the team's question
    | 'internal_note' // a colleague added an internal note
    | 'assigned' // the request was assigned to the recipient
    | 'reopened' // the customer reopened a deployed request
    | 'cancelled' // the customer cancelled it
    | 'sla_warning' // a response/resolution target is about to be missed
    | 'sla_breached' // ... or has been
    | 'approval_needed' // (phase 4) a customer approver must approve it
    | 'approved'
    | 'rejected'
    | 'agent_proposal' // an assistant proposed a step that needs a decision
    | 'agent_lapsed' // an assistant stopped working the request
    | 'agent_handoff' // an assistant handed the request over
    | 'agent_deploy_check'; // an assistant's deployment did not verify, or did not finish cleanly
  author: string | null;
  body: string | null;
  runUrl: string;
}

/**
 * Incident emails (docs/INCIDENT-MANAGEMENT.md). Customer-side mail goes to the
 * reporter and anyone following the incident; team-side mail goes to the
 * assignee, or every engineer and Super Admin on the customer when nobody is.
 */

/** `incident_created`: to the reporter ("we've got it") and to the team. */
export interface IncidentCreatedContext {
  audience: 'reporter' | 'team';
  customerName: string;
  /** e.g. INC-0042 */
  reference: string;
  title: string;
  categoryLabel: string;
  siteLabel: string | null;
  /** "P2 High" for the team, "high" for the customer */
  priorityLabel: string;
  raisedBy: string;
  /** Reporter only: "We aim to respond within 1 hour." */
  respondText: string | null;
  /** The category's answers as label/value pairs. */
  lines: { label: string; value: string }[];
  runUrl: string;
}

/** `incident_status_changed`: to the reporter and followers - the incident moved on. */
export interface IncidentStatusChangedContext {
  customerName: string;
  reference: string;
  title: string;
  kind: 'acknowledge' | 'hold' | 'restore' | 'close' | 'cancel' | 'duplicate' | 'reopen' | 'priority' | 'auto_close';
  /** What it is on hold for, in customer words ("Waiting on your carrier"). */
  holdLabel?: string | null;
  /** The note shown to the customer. */
  note?: string | null;
  /** priority only: "high" */
  priorityText?: string | null;
  runUrl: string;
}

/**
 * `incident_message`: to the reporter and followers - the team wrote to them.
 *  comment  - a public update
 *  question - the team needs something before it can carry on (the incident is on hold, waiting on them)
 *  reminder - the question is still unanswered (worker, every few days)
 */
export interface IncidentMessageContext {
  customerName: string;
  reference: string;
  title: string;
  kind: 'comment' | 'question' | 'reminder';
  author: string;
  body: string;
  runUrl: string;
}

/** `incident_resolved`: the team says it is fixed. The two links answer without signing in. */
export interface IncidentResolvedContext {
  customerName: string;
  reference: string;
  title: string;
  author: string;
  note: string | null;
  /** Signed link: opens a page that confirms it is fixed. */
  fixedUrl: string;
  /** Signed link: opens a page that says it is still broken. */
  brokenUrl: string;
  /** Days until it closes by itself. */
  autoCloseDays: number;
  runUrl: string;
}

/** `incident_activity`: to the team - something happened on an incident they need to see. */
export interface IncidentActivityContext {
  customerName: string;
  reference: string;
  title: string;
  categoryLabel: string;
  priorityLabel: string;
  kind:
    | 'comment' // the customer commented
    | 'replied' // the customer answered the team's question
    | 'internal_note' // a colleague added an internal note
    | 'assigned' // the incident was assigned to the recipient
    | 'reopened' // the customer said it is still broken
    | 'cancelled' // the customer cancelled it
    | 'confirmed' // the customer confirmed it is fixed
    | 'sla_warning' // a target is about to be missed
    | 'sla_breached' // ... or has been
    | 'update_due' // a major incident's customer update is due (to the comms owner)
    | 'update_overdue' // ... and is late (to the lead and the team)
    | 'major_assigned' // you are the lead or comms owner of a major incident
    | 'agent_proposal' // an AI assistant proposed a next step for a person to decide
    | 'agent_lapsed' // an AI assistant stopped working the incident; it is back in the queue
    | 'agent_handoff'; // an AI assistant handed the incident to the team, with a summary
  author: string | null;
  body: string | null;
  runUrl: string;
}

/**
 * `incident_major`: a major incident - declared, updated, or over. To the customer side
 * (the reporter, followers, the customer's stakeholders and the reporters of its child
 * incidents); the team is told when it is declared.
 */
export interface IncidentMajorContext {
  audience: 'customer' | 'team';
  customerName: string;
  reference: string;
  title: string;
  kind: 'declared' | 'update' | 'resolved';
  priorityLabel: string;
  siteLabel: string | null;
  lead: string;
  /** The update itself (or, when it is over, what fixed it). */
  body: string;
  /** "We'll update you again by 15:30." Null when it is over. */
  nextUpdateText: string | null;
  runUrl: string;
}

/** `incident_review`: a post-incident review was shared with the customer. */
export interface IncidentReviewContext {
  customerName: string;
  reference: string;
  title: string;
  summary: string;
  cause: string;
  actions: { text: string; owner?: string; due?: string }[];
  runUrl: string;
}

/** Loose map used at the enqueue/render boundary. */
/** Context for the `sso_admin_signin` template: someone signed in as Super Admin through a single sign-on provider. */
export interface SsoAdminSigninContext {
  /** Who signed in. */
  displayName: string;
  email: string;
  providerName: string;
  /** The provider's own session id (the hub's), when it sent one. */
  providerSessionId: string | null;
  installation: string;
  at: string;
  ip: string | null;
}

/** Context for the `sso_staff_access_request` template: a Voxshift staff account is waiting for an administrator of this installation to approve its sign-in. */
export interface SsoStaffAccessRequestContext {
  displayName: string;
  email: string;
  /** The role the sign-in would get, as the screens name it. */
  role: string;
  at: string;
  ip: string | null;
  installation: string;
  /** Where to approve or deny. */
  reviewUrl: string;
}

export type EmailContext = Record<string, unknown>;
