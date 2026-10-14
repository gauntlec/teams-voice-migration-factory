import {
  BUG_STATUS_LABELS,
  SR_STATUS_CUSTOMER_LABELS,
  FEATURE_STATUS_LABELS,
  type BugReportStatusChangedContext,
  type DeploymentCompletedContext,
  type DiscoveryCompletedContext,
  type EmailTemplate,
  type IncidentActivityContext,
  type IncidentCreatedContext,
  type IncidentMajorContext,
  type IncidentMessageContext,
  type IncidentReviewContext,
  type IncidentResolvedContext,
  type IncidentStatusChangedContext,
  type FeatureRequestStatusChangedContext,
  type PortDocumentItemSummary,
  type PortDocumentsCompletedContext,
  type PortDocumentsReminderContext,
  type PortDocumentsRequestedContext,
  type ServiceRequestCreatedContext,
  type ServiceRequestActivityContext,
  type ServiceRequestMessageContext,
  type ServiceRequestStatusChangedContext,
  type UserInvitationContext,
} from '@tvmf/shared';
import { renderHtml, renderText, type EmailBranding, type LayoutInput } from './layout';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Turn a stored `template` + `context` into a ready-to-send email. Add a new
 * kind by adding a `case` here and a name in `packages/shared/src/email.ts`.
 * `branding` applies to every template with a single resolvable owner -
 * tenant-scoped templates, and invitations/resets when the recipient
 * resolves to exactly one tenant or MSP (see UsersService.sendInvitation).
 * feature/bug status emails are genuinely platform-level (no single owner)
 * and always render default Voxshift branding.
 */
export function renderEmail(template: string, context: Record<string, unknown>, branding?: EmailBranding): RenderedEmail {
  switch (template as EmailTemplate) {
    case 'user_invitation':
      return invitation(context as unknown as UserInvitationContext, branding);
    case 'discovery_completed':
      return discoveryCompleted(context as unknown as DiscoveryCompletedContext, branding);
    case 'deployment_completed':
      return deploymentCompleted(context as unknown as DeploymentCompletedContext, branding);
    case 'port_documents_requested':
      return portDocumentsRequested(context as unknown as PortDocumentsRequestedContext, branding);
    case 'port_documents_reminder':
      return portDocumentsReminder(context as unknown as PortDocumentsReminderContext, branding);
    case 'port_documents_completed':
      return portDocumentsCompleted(context as unknown as PortDocumentsCompletedContext, branding);
    case 'feature_request_status_changed':
      return featureRequestStatusChanged(context as unknown as FeatureRequestStatusChangedContext);
    case 'bug_report_status_changed':
      return bugReportStatusChanged(context as unknown as BugReportStatusChangedContext);
    case 'service_request_created':
      return serviceRequestCreated(context as unknown as ServiceRequestCreatedContext, branding);
    case 'service_request_status_changed':
      return serviceRequestStatusChanged(context as unknown as ServiceRequestStatusChangedContext, branding);
    case 'service_request_message':
      return serviceRequestMessage(context as unknown as ServiceRequestMessageContext, branding);
    case 'service_request_activity':
      return serviceRequestActivity(context as unknown as ServiceRequestActivityContext, branding);
    case 'incident_created':
      return incidentCreated(context as unknown as IncidentCreatedContext, branding);
    case 'incident_status_changed':
      return incidentStatusChanged(context as unknown as IncidentStatusChangedContext, branding);
    case 'incident_message':
      return incidentMessage(context as unknown as IncidentMessageContext, branding);
    case 'incident_resolved':
      return incidentResolved(context as unknown as IncidentResolvedContext, branding);
    case 'incident_activity':
      return incidentActivity(context as unknown as IncidentActivityContext, branding);
    case 'incident_major':
      return incidentMajor(context as unknown as IncidentMajorContext, branding);
    case 'incident_review':
      return incidentReview(context as unknown as IncidentReviewContext, branding);
    default:
      throw new Error(`unknown email template: ${template}`);
  }
}

function invitation(c: UserInvitationContext, branding?: EmailBranding): RenderedEmail {
  const subject = "You've been invited to Voxshift";
  const scope =
    c.tenantNames && c.tenantNames.length
      ? `You have been given access to: ${c.tenantNames.join(', ')}.`
      : 'Your customer access will be configured by your project team.';

  const layout: LayoutInput = {
    previewText: 'Your account is ready — here is your temporary password.',
    eyebrow: 'Account invitation',
    heading: `Welcome to Voxshift, ${c.displayName}`,
    intro: [
      `${c.inviterEmail} has set up an account for you on Voxshift, the platform used to run your Microsoft Teams voice migration.`,
      `Your role is ${c.role}. ${scope}`,
      'Sign in with the temporary password below. You will then be asked to choose your own password and set up an authenticator app for two-factor sign-in.',
    ],
    callout: { label: 'Temporary password', value: c.tempPassword },
    cta: { label: 'Sign in to Voxshift', url: c.signInUrl },
    outro: [
      'This temporary password works once, only to sign in. If you were not expecting this invitation, you can ignore this email.',
    ],
  };

  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

function discoveryCompleted(c: DiscoveryCompletedContext, branding?: EmailBranding): RenderedEmail {
  const failed = c.outcome === 'failed';
  const withErrors = c.outcome === 'completed_with_errors';

  const subject = failed
    ? `Discovery failed — ${c.customerName}`
    : `Discovery complete — ${c.customerName}`;

  const changeParts = [
    c.added ? `${c.added} added` : null,
    c.updated ? `${c.updated} updated` : null,
    c.removed ? `${c.removed} removed` : null,
    c.readded ? `${c.readded} re-added` : null,
  ].filter(Boolean) as string[];
  const changeLine = changeParts.length ? changeParts.join(' · ') : 'No changes since the last run';

  const intro = [
    failed
      ? `The tenant discovery you started for ${c.customerName} did not finish.`
      : `The tenant discovery you started for ${c.customerName} has finished${
          withErrors ? ', with some non-fatal errors' : ''
        }.`,
    `${c.scopeLabel} · ran for ${c.durationText}.`,
  ];
  if (failed && c.errorMessage) intro.push(c.errorMessage);

  const stats: string[] = [];
  if (!failed) stats.push(`Snapshot now holds ${c.totalObjects.toLocaleString()} objects.`);
  if (c.breakdown.length) {
    stats.push(
      c.breakdown.map((b) => `${b.count.toLocaleString()} ${b.label}`).join(' · ') + '.',
    );
  }
  if (c.skippedNotLicensed) {
    stats.push(
      `${c.skippedNotLicensed.toLocaleString()} user accounts were skipped — not licensed for Teams.`,
    );
  }
  if (c.filterNote) stats.push(c.filterNote);
  if (c.errorCount) {
    stats.push(
      `${c.errorCount} step ${c.errorCount === 1 ? 'error was' : 'errors were'} recorded — open Discovery to review them.`,
    );
  }

  const layout: LayoutInput = {
    previewText: failed
      ? `Discovery for ${c.customerName} did not finish.`
      : `Discovery for ${c.customerName}: ${changeLine}.`,
    eyebrow: 'Tenant discovery',
    heading: failed
      ? `Discovery did not finish — ${c.customerName}`
      : `Discovery complete — ${c.customerName}`,
    intro,
    callout: failed ? undefined : { label: 'What changed', value: changeLine },
    cta: { label: 'Open Discovery', url: c.runUrl },
    outro: [
      ...stats,
      'You are receiving this because you started this discovery run. A project administrator can turn these emails off per customer in the Discovery settings.',
    ],
  };

  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

function deploymentCompleted(c: DeploymentCompletedContext, branding?: EmailBranding): RenderedEmail {
  const failed = c.outcome === 'failed';
  const withErrors = c.outcome === 'completed_with_errors';
  const modeLabel = c.mode === 'dry_run' ? 'What-If' : 'Execute';
  const failureWord = c.failed === 1 ? 'failure' : 'failures';

  const subject = failed
    ? `Deployment failed — ${c.siteName}`
    : withErrors
      ? `Deployment completed with ${c.failed} ${failureWord} — ${c.siteName}`
      : `Deployment complete — ${c.siteName}`;

  const summaryLine = `applied:${c.applied}  whatif:${c.whatif}  skipped:${c.skipped}  failed:${c.failed}`;

  const intro = [
    failed
      ? `The ${modeLabel} deployment you ran for ${c.siteName} (${c.sitecode}) at ${c.customerName} did not finish.`
      : `The ${modeLabel} deployment you ran for ${c.siteName} (${c.sitecode}) at ${c.customerName} has completed${
          withErrors ? `, but ${c.failed} ${failureWord} to ${c.total} planned change${c.total === 1 ? '' : 's'} failed` : ''
        }.`,
    `${c.total} change${c.total === 1 ? '' : 's'} processed · ran for ${c.durationText}.`,
  ];
  if (failed && c.errorMessage) intro.push(c.errorMessage);

  const outro: string[] = [];
  if (c.failures.length) {
    outro.push('What failed, and why:');
    for (const f of c.failures) outro.push(`${f.object} · ${f.cmdlet} — ${f.message}`);
  }
  outro.push('You are receiving this because you ran this deployment.');

  const layout: LayoutInput = {
    previewText: failed
      ? `Deployment for ${c.siteName} did not finish.`
      : `Deployment for ${c.siteName}: ${summaryLine}.`,
    eyebrow: 'Deployment',
    heading: failed
      ? `Deployment did not finish — ${c.siteName}`
      : withErrors
        ? `Completed with ${c.failed} ${failureWord} — ${c.siteName}`
        : `Deployment complete — ${c.siteName}`,
    intro,
    callout: failed ? undefined : { label: 'Result', value: summaryLine },
    cta: { label: 'Open Deployment', url: c.runUrl },
    outro,
  };

  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

const STATUS_LABEL: Record<PortDocumentItemSummary['status'], string> = {
  pending: 'Needed',
  uploaded: 'Uploaded',
  rejected: 'Needs re-upload',
  waived: 'Not required',
};

/** One line per checklist item, for the intro/outro of the two port-document emails below. */
function itemLines(items: PortDocumentItemSummary[]): string[] {
  return items
    .filter((i) => i.status !== 'waived')
    .map((i) => {
      const parts = [`${i.label} — ${STATUS_LABEL[i.status]}`];
      if (i.note) parts.push(`(${i.note})`);
      if (i.status === 'rejected' && i.rejectReason) parts.push(`— ${i.rejectReason}`);
      return parts.join(' ');
    });
}

function portDocumentsRequested(c: PortDocumentsRequestedContext, branding?: EmailBranding): RenderedEmail {
  const outstanding = c.items.filter((i) => i.status !== 'uploaded' && i.status !== 'waived').length;
  const subject = `Documents needed to port your numbers — ${c.siteName}`;
  const layout: LayoutInput = {
    previewText: `${outstanding} document${outstanding === 1 ? '' : 's'} needed for ${c.rangeLabel}.`,
    eyebrow: 'Number porting',
    heading: `Documents needed — ${c.siteName}`,
    intro: [
      `To port your numbers for ${c.rangeLabel} at ${c.siteName}, we need the following from you:`,
      ...itemLines(c.items),
    ],
    cta: { label: 'Upload documents', url: c.portalUrl },
    outro: ['Use the link above to upload each document. We will let you know if anything needs to be redone.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

function portDocumentsReminder(c: PortDocumentsReminderContext, branding?: EmailBranding): RenderedEmail {
  const outstanding = c.items.filter((i) => i.status !== 'uploaded' && i.status !== 'waived').length;
  const subject = `Reminder: documents still needed — ${c.siteName}`;
  const layout: LayoutInput = {
    previewText: `${outstanding} document${outstanding === 1 ? '' : 's'} still outstanding for ${c.rangeLabel}.`,
    eyebrow: 'Number porting · reminder',
    heading: `Still waiting on ${outstanding} document${outstanding === 1 ? '' : 's'} — ${c.siteName}`,
    intro: [
      `This is a reminder that porting ${c.rangeLabel} at ${c.siteName} is waiting on:`,
      ...itemLines(c.items),
    ],
    cta: { label: 'Upload documents', url: c.portalUrl },
    outro: ['If you have already sent these another way, let your project contact know and we will update this request.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

function portDocumentsCompleted(c: PortDocumentsCompletedContext, branding?: EmailBranding): RenderedEmail {
  const subject = `All documents received — ${c.siteName}`;
  const layout: LayoutInput = {
    previewText: `Every requested document for ${c.rangeLabel} has been provided.`,
    eyebrow: 'Number porting',
    heading: `All documents received — ${c.siteName}`,
    intro: [
      `${c.customerName} has provided every document requested for ${c.rangeLabel} at ${c.siteName}. This request is now complete.`,
    ],
    cta: { label: 'Review request', url: c.runUrl },
    outro: ['You are receiving this because you submitted this document request.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

function featureRequestStatusChanged(c: FeatureRequestStatusChangedContext): RenderedEmail {
  const fromLabel = FEATURE_STATUS_LABELS[c.fromStatus];
  const toLabel = FEATURE_STATUS_LABELS[c.toStatus];
  const shipped = c.toStatus === 'deployed';
  const subject = `${toLabel} — ${c.title}`;
  const layout: LayoutInput = {
    previewText: `Your feature request "${c.title}" is now ${toLabel}.`,
    eyebrow: 'Feature request',
    heading: shipped ? `Shipped — ${c.title}` : `${toLabel} — ${c.title}`,
    intro: [
      `Your feature request "${c.title}" (${c.area}) moved from ${fromLabel} to ${toLabel}.`,
      ...(c.decisionNote ? [c.decisionNote] : []),
    ],
    cta: { label: 'View feature request', url: c.runUrl },
    outro: ['You are receiving this because you submitted this feature request.'],
  };
  return { subject, html: renderHtml(layout), text: renderText(layout) };
}

function bugReportStatusChanged(c: BugReportStatusChangedContext): RenderedEmail {
  const fromLabel = BUG_STATUS_LABELS[c.fromStatus];
  const toLabel = BUG_STATUS_LABELS[c.toStatus];
  const shipped = c.toStatus === 'deployed';
  const subject = `${toLabel} — ${c.title}`;
  const layout: LayoutInput = {
    previewText: `Your bug report "${c.title}" is now ${toLabel}.`,
    eyebrow: 'Bug report',
    heading: shipped ? `Fix shipped — ${c.title}` : `${toLabel} — ${c.title}`,
    intro: [
      `Your bug report "${c.title}" (${c.area}) moved from ${fromLabel} to ${toLabel}.`,
      ...(c.resolutionNote ? [c.resolutionNote] : []),
    ],
    cta: { label: 'View bug report', url: c.runUrl },
    outro: ['You are receiving this because you reported this bug.'],
  };
  return { subject, html: renderHtml(layout), text: renderText(layout) };
}

/** To the engineers and admins on a customer: a new service request needs actioning. */
function serviceRequestCreated(c: ServiceRequestCreatedContext, branding?: EmailBranding): RenderedEmail {
  const subject = `New service request ${c.reference} — ${c.customerName}`;
  const facts = [
    `Type: ${c.typeLabel}`,
    ...(c.siteLabel ? [`Site: ${c.siteLabel}`] : []),
    `Priority: ${c.priority}`,
    `Raised by: ${c.requestedBy}`,
  ];
  const layout: LayoutInput = {
    previewText: `${c.requestedBy} raised ${c.reference}: ${c.title}`,
    eyebrow: 'Managed Services',
    heading: `${c.reference} — ${c.title}`,
    intro: [`${c.customerName} has raised a new service request.`, ...facts, ...c.lines.map((l) => `${l.label}: ${l.value}`)],
    cta: { label: 'Open the request', url: c.runUrl },
    outro: ['You are receiving this because you are an engineer or admin for this customer.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** To the person who raised a request: it moved on, was sent back, reopened, declined or cancelled. Uses the customer's status names. */
function serviceRequestStatusChanged(c: ServiceRequestStatusChangedContext, branding?: EmailBranding): RenderedEmail {
  const toLabel = SR_STATUS_CUSTOMER_LABELS[c.toStatus];
  const lead: Record<string, string> = {
    planned: "Your request has been scheduled. The team is now working on it.",
    built: 'Your change is ready to go live. The team will make it live shortly.',
    deployed: 'Your change is now live.',
    cancelled: 'Your request has been cancelled.',
    declined: "The team can't go ahead with your request.",
  };
  const reopened = c.moveKind === 'reopen';
  const subject = reopened ? `${c.reference} reopened — ${c.title}` : `${c.reference} ${toLabel.toLowerCase()} — ${c.title}`;
  const layout: LayoutInput = {
    previewText: reopened ? `${c.reference} has been reopened.` : `${c.reference} is now ${toLabel}.`,
    eyebrow: 'Service request update',
    heading: reopened ? `${c.reference} — Reopened` : `${c.reference} — ${toLabel}`,
    intro: [
      `${c.title} (${c.typeLabel})`,
      reopened
        ? 'Your request has been reopened and the team is looking at it again.'
        : (lead[c.toStatus] ?? `Your request moved from ${SR_STATUS_CUSTOMER_LABELS[c.fromStatus]} to ${toLabel}.`),
      ...(c.note ? [`${c.toStatus === 'declined' ? 'Reason' : 'Note from the team'}: ${c.note}`] : []),
    ],
    cta: { label: 'View your request', url: c.runUrl },
    outro: ['You are receiving this because you raised this request.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** To the person who raised a request: a reply, a question that needs answering, or a reminder about one. */
function serviceRequestMessage(c: ServiceRequestMessageContext, branding?: EmailBranding): RenderedEmail {
  const subject =
    c.kind === 'question'
      ? `${c.reference} needs your reply — ${c.title}`
      : c.kind === 'reminder'
        ? `Reminder: ${c.reference} is waiting for your reply`
        : `New reply on ${c.reference} — ${c.title}`;
  const lead =
    c.kind === 'question'
      ? `${c.author} needs some information before the team can carry on with your request:`
      : c.kind === 'reminder'
        ? `The team is still waiting for your reply before it can carry on with your request. ${c.author} asked:`
        : `${c.author} replied on your request:`;
  const layout: LayoutInput = {
    previewText: c.body.slice(0, 120),
    eyebrow: 'Service request',
    heading: `${c.reference} — ${c.title}`,
    intro: [lead, c.body, ...(c.kind === 'comment' ? [] : ['Reply on the request page and the team will pick it up straight away.'])],
    cta: { label: c.kind === 'comment' ? 'View your request' : 'Reply now', url: c.runUrl },
    outro: ['You are receiving this because you raised this request.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** To the team: the customer wrote or reopened, a request was assigned to you, a target is at risk, an approval came in. */
function serviceRequestActivity(c: ServiceRequestActivityContext, branding?: EmailBranding): RenderedEmail {
  const who = c.author ?? 'Someone';
  const what: Record<ServiceRequestActivityContext['kind'], { subject: string; lead: string }> = {
    comment: { subject: `${c.reference}: new comment from the customer`, lead: `${who} commented:` },
    replied: { subject: `${c.reference}: the customer replied`, lead: `${who} answered your question, so the request is no longer waiting on them:` },
    internal_note: { subject: `${c.reference}: internal note`, lead: `${who} added an internal note:` },
    assigned: { subject: `${c.reference} assigned to you`, lead: `${who} assigned this request to you.` },
    reopened: { subject: `${c.reference} reopened by the customer`, lead: `${who} reopened this deployed request:` },
    cancelled: { subject: `${c.reference} cancelled by the customer`, lead: `${who} cancelled this request.` },
    sla_warning: { subject: `${c.reference} is about to miss its target`, lead: 'This request is close to missing its target:' },
    sla_breached: { subject: `${c.reference} has missed its target`, lead: 'This request has missed its target:' },
    approval_needed: { subject: `${c.reference} needs your approval`, lead: `${who} raised a request that needs your approval before the team can start.` },
    approved: { subject: `${c.reference} approved`, lead: `${who} approved this request. You can now plan it.` },
    rejected: { subject: `${c.reference} rejected by the approver`, lead: `${who} rejected this request:` },
    agent_proposal: { subject: `${c.reference}: an assistant needs a decision`, lead: `${who} proposed a next step. Open the request to approve or reject it:` },
    agent_lapsed: { subject: `${c.reference}: an assistant stopped working on it`, lead: `${who} stopped working on this request, so it is back in the queue:` },
    agent_handoff: { subject: `${c.reference}: handed over by an assistant`, lead: `${who} handed this request over to the team:` },
    agent_deploy_check: { subject: `${c.reference}: check this deployment`, lead: `${who} deployed this request but the result needs a person to look at it:` },
  };
  const w = what[c.kind];
  const layout: LayoutInput = {
    previewText: w.lead,
    eyebrow: `Managed Services · ${c.customerName}`,
    heading: `${c.reference} — ${c.title}`,
    intro: [`${c.typeLabel} for ${c.customerName}.`, w.lead, ...(c.body ? [c.body] : [])],
    cta: { label: c.kind === 'approval_needed' ? 'Review the request' : 'Open the request', url: c.runUrl },
    outro: [
      c.kind === 'approval_needed'
        ? 'You are receiving this because you approve service requests for your organisation.'
        : 'You are receiving this because you work on this customer\'s service requests.',
    ],
  };
  return { subject: w.subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/* ------------------------------ incidents ------------------------------ */

/** To the person who raised an incident ("we've got it"), and to the team ("new incident"). */
function incidentCreated(c: IncidentCreatedContext, branding?: EmailBranding): RenderedEmail {
  if (c.audience === 'reporter') {
    const layout: LayoutInput = {
      previewText: `We have ${c.reference} and the team has been told.`,
      eyebrow: 'Incident received',
      heading: `${c.reference} — ${c.title}`,
      intro: [
        `Thanks - we have your incident and the engineers looking after ${c.customerName} have been told.`,
        `${c.categoryLabel}${c.siteLabel ? ` · ${c.siteLabel}` : ''}`,
        `We're treating this as ${c.priorityLabel} priority.${c.respondText ? ` ${c.respondText}` : ''}`,
        'If anything changes, or you have another example call, add it on the incident page.',
      ],
      cta: { label: 'View your incident', url: c.runUrl },
      outro: ['You are receiving this because you raised this incident.'],
    };
    return { subject: `We've got it: ${c.reference} — ${c.title}`, html: renderHtml(layout, branding), text: renderText(layout) };
  }
  const layout: LayoutInput = {
    previewText: `${c.raisedBy} raised ${c.reference}: ${c.title}`,
    eyebrow: `Incident · ${c.customerName}`,
    heading: `${c.reference} — ${c.title}`,
    intro: [
      `${c.customerName} has raised a ${c.priorityLabel} incident.`,
      `Category: ${c.categoryLabel}`,
      ...(c.siteLabel ? [`Site: ${c.siteLabel}`] : []),
      `Raised by: ${c.raisedBy}`,
      ...c.lines.map((l) => `${l.label}: ${l.value}`),
    ],
    cta: { label: 'Open the incident', url: c.runUrl },
    outro: ['You are receiving this because you are an engineer or admin for this customer.'],
  };
  return { subject: `New ${c.priorityLabel} incident ${c.reference} — ${c.customerName}`, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** To the reporter and followers: the incident moved on. */
function incidentStatusChanged(c: IncidentStatusChangedContext, branding?: EmailBranding): RenderedEmail {
  const lead: Record<IncidentStatusChangedContext['kind'], { subject: string; heading: string; text: string }> = {
    acknowledge: { subject: `${c.reference} is being worked on`, heading: 'Being worked on', text: 'An engineer has picked up your incident and is working on it.' },
    hold: {
      subject: `${c.reference} is on hold`,
      heading: 'On hold',
      text: `Your incident is on hold${c.holdLabel ? `: ${c.holdLabel.toLowerCase()}` : ''}. We'll carry on as soon as we can.`,
    },
    restore: {
      subject: `Service restored: ${c.reference}`,
      heading: 'Service restored',
      text: "Service is working again. We're keeping the incident open while we confirm the cause and make sure it holds.",
    },
    close: { subject: `${c.reference} is closed`, heading: 'Closed', text: 'Your incident is closed.' },
    auto_close: {
      subject: `${c.reference} is closed`,
      heading: 'Closed',
      text: "We haven't heard it is still a problem, so we've closed this incident. If it is still broken, reopen it from the incident page within a week.",
    },
    cancel: { subject: `${c.reference} was cancelled`, heading: 'Cancelled', text: 'This incident was cancelled.' },
    duplicate: { subject: `${c.reference} is covered by another incident`, heading: 'Covered by another incident', text: "This is the same problem as another incident we're already working on, so we've combined them." },
    reopen: { subject: `${c.reference} reopened`, heading: 'Reopened', text: 'Your incident has been reopened and the team is looking at it again.' },
    priority: { subject: `${c.reference} priority changed`, heading: 'Priority changed', text: `The team has changed the priority of your incident to ${c.priorityText ?? 'a new level'}.` },
  };
  const l = lead[c.kind];
  const layout: LayoutInput = {
    previewText: l.text,
    eyebrow: 'Incident update',
    heading: `${c.reference} — ${l.heading}`,
    intro: [c.title, l.text, ...(c.note ? [`Note from the team: ${c.note}`] : [])],
    cta: { label: 'View your incident', url: c.runUrl },
    outro: ['You are receiving this because you raised, or are following, this incident.'],
  };
  return { subject: `${l.subject} — ${c.title}`, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** To the reporter and followers: a public update, a question that needs answering, or a reminder about one. */
function incidentMessage(c: IncidentMessageContext, branding?: EmailBranding): RenderedEmail {
  const subject =
    c.kind === 'question'
      ? `${c.reference} needs your reply — ${c.title}`
      : c.kind === 'reminder'
        ? `Reminder: ${c.reference} is waiting for your reply`
        : `Update on ${c.reference} — ${c.title}`;
  const lead =
    c.kind === 'question'
      ? `${c.author} needs some information before the team can carry on with your incident:`
      : c.kind === 'reminder'
        ? `The team is still waiting for your reply before it can carry on with your incident. ${c.author} asked:`
        : `${c.author} has an update on your incident:`;
  const layout: LayoutInput = {
    previewText: c.body.slice(0, 120),
    eyebrow: 'Incident',
    heading: `${c.reference} — ${c.title}`,
    intro: [lead, c.body, ...(c.kind === 'comment' ? [] : ['Reply on the incident page and the team will pick it up straight away.'])],
    cta: { label: c.kind === 'comment' ? 'View your incident' : 'Reply now', url: c.runUrl },
    outro: ['You are receiving this because you raised, or are following, this incident.'],
  };
  return { subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** The team says it is fixed: the customer answers from the email, without signing in. */
function incidentResolved(c: IncidentResolvedContext, branding?: EmailBranding): RenderedEmail {
  const layout: LayoutInput = {
    previewText: `${c.reference} is fixed - please confirm it is working for you.`,
    eyebrow: 'Incident resolved',
    heading: `${c.reference} — ${c.title}`,
    intro: [
      `${c.author} has marked your incident as resolved.`,
      ...(c.note ? [`What was done: ${c.note}`] : []),
      'Please check it is working for you.',
    ],
    cta: { label: "Yes, it's fixed", url: c.fixedUrl },
    secondaryCta: { label: 'No, it is still broken', url: c.brokenUrl },
    outro: [
      `If we don't hear from you, we'll close the incident after ${c.autoCloseDays} days. You can still reopen it from the incident page for a week after it was resolved: ${c.runUrl}`,
    ],
  };
  return { subject: `Is ${c.reference} fixed? — ${c.title}`, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** To the team: the customer wrote, reopened or cancelled; it was assigned to you; a target is at risk or missed. */
function incidentActivity(c: IncidentActivityContext, branding?: EmailBranding): RenderedEmail {
  const who = c.author ?? 'Someone';
  const what: Record<IncidentActivityContext['kind'], { subject: string; lead: string }> = {
    comment: { subject: `${c.reference}: new comment from the customer`, lead: `${who} commented:` },
    replied: { subject: `${c.reference}: the customer replied`, lead: `${who} answered your question, so the incident is no longer on hold:` },
    internal_note: { subject: `${c.reference}: internal note`, lead: `${who} added an internal note:` },
    assigned: { subject: `${c.reference} assigned to you`, lead: `${who} assigned this incident to you.` },
    reopened: { subject: `${c.reference} reopened: still broken`, lead: `${who} says the incident is still broken:` },
    cancelled: { subject: `${c.reference} cancelled by the customer`, lead: `${who} cancelled this incident.` },
    confirmed: { subject: `${c.reference} confirmed fixed`, lead: `${who} confirmed the fix, so the incident is closed.` },
    sla_warning: { subject: `${c.reference} is about to miss a target`, lead: 'This incident is close to missing a target:' },
    sla_breached: { subject: `${c.reference} has missed a target`, lead: 'This incident has missed a target:' },
    update_due: { subject: `${c.reference}: customer update due`, lead: 'The next customer update on this major incident is due now. Post it from the incident page:' },
    update_overdue: { subject: `${c.reference}: customer update is late`, lead: 'The customer update on this major incident is late, and the comms owner has not posted it:' },
    agent_proposal: { subject: `${c.reference}: an assistant needs a decision`, lead: `${who} proposed a next step. Open the incident to approve or reject it:` },
    agent_lapsed: { subject: `${c.reference}: an assistant stopped; it is back in the queue`, lead: `${who} stopped working on this incident:` },
    agent_handoff: { subject: `${c.reference}: an assistant handed this to the team`, lead: `${who} handed this incident to the team. Its summary:` },
    major_assigned: { subject: `${c.reference}: you are on a major incident`, lead: `${who} made you ${c.body ?? 'part of the response'} on this major incident.` },
  };
  const w = what[c.kind];
  const layout: LayoutInput = {
    previewText: w.lead,
    eyebrow: `Incident · ${c.customerName}`,
    heading: `${c.reference} — ${c.title}`,
    intro: [`${c.priorityLabel} · ${c.categoryLabel}`, w.lead, ...(c.body && c.kind !== 'major_assigned' ? [c.body] : [])],
    cta: { label: 'Open the incident', url: c.runUrl },
    outro: ["You are receiving this because you work on this customer's incidents."],
  };
  return { subject: w.subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** A major incident: to the customer side as it is declared, updated and resolved; to the team when it is declared. */
function incidentMajor(c: IncidentMajorContext, branding?: EmailBranding): RenderedEmail {
  const team = c.audience === 'team';
  const lead: Record<IncidentMajorContext['kind'], { subject: string; eyebrow: string; text: string }> = {
    declared: {
      subject: team ? `MAJOR INCIDENT ${c.reference} — ${c.customerName}` : `We're aware of a problem: ${c.reference} — ${c.title}`,
      eyebrow: 'Major incident',
      text: team ? `${c.lead} has declared this a major incident and is leading the response.` : "We're aware of a serious problem and have a team working on it.",
    },
    update: { subject: `Update on ${c.reference} — ${c.title}`, eyebrow: 'Major incident update', text: 'Here is the latest on the problem we are working on:' },
    resolved: { subject: `Resolved: ${c.reference} — ${c.title}`, eyebrow: 'Major incident resolved', text: 'The problem is resolved. Thank you for your patience.' },
  };
  const l = lead[c.kind];
  const layout: LayoutInput = {
    previewText: c.body.slice(0, 120),
    eyebrow: `${l.eyebrow}${team ? ` · ${c.customerName}` : ''}`,
    heading: `${c.reference} — ${c.title}`,
    intro: [
      l.text,
      ...(c.siteLabel ? [`Site: ${c.siteLabel}`] : ['Affects: all sites']),
      ...(team ? [`Priority: ${c.priorityLabel}`] : []),
      c.body,
      ...(c.nextUpdateText ? [c.nextUpdateText] : []),
    ],
    cta: { label: team ? 'Open the incident' : 'View the incident', url: c.runUrl },
    outro: [team ? "You are receiving this because you work on this customer's incidents." : 'You are receiving this because you raised, follow, or are a named contact for incidents on this service.'],
  };
  return { subject: l.subject, html: renderHtml(layout, branding), text: renderText(layout) };
}

/** A post-incident review shared with the customer. */
function incidentReview(c: IncidentReviewContext, branding?: EmailBranding): RenderedEmail {
  const layout: LayoutInput = {
    previewText: `The review of ${c.reference} is ready.`,
    eyebrow: 'Post-incident review',
    heading: `${c.reference} — ${c.title}`,
    intro: [
      'We have reviewed what happened and what we are doing about it.',
      ...(c.summary ? [`What happened: ${c.summary}`] : []),
      ...(c.cause ? [`Why it happened: ${c.cause}`] : []),
      ...(c.actions.length ? ['What we are doing about it:', ...c.actions.map((a) => `• ${a.text}${a.owner ? ` (${a.owner}` : ''}${a.due ? `${a.owner ? ', ' : ' ('}by ${a.due}` : ''}${a.owner || a.due ? ')' : ''}`)] : []),
    ],
    cta: { label: 'Read the full review', url: c.runUrl },
    outro: ['You are receiving this because you raised, follow, or are a named contact for incidents on this service.'],
  };
  return { subject: `Review: ${c.reference} — ${c.title}`, html: renderHtml(layout, branding), text: renderText(layout) };
}
