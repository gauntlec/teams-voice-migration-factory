import type {
  DiscoveryCompletedContext,
  EmailTemplate,
  PortDocumentItemSummary,
  PortDocumentsCompletedContext,
  PortDocumentsReminderContext,
  PortDocumentsRequestedContext,
  UserInvitationContext,
} from '@tvmf/shared';
import { renderHtml, renderText, type LayoutInput } from './layout';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Turn a stored `template` + `context` into a ready-to-send email. Add a new
 * kind by adding a `case` here and a name in `packages/shared/src/email.ts`.
 */
export function renderEmail(template: string, context: Record<string, unknown>): RenderedEmail {
  switch (template as EmailTemplate) {
    case 'user_invitation':
      return invitation(context as unknown as UserInvitationContext);
    case 'discovery_completed':
      return discoveryCompleted(context as unknown as DiscoveryCompletedContext);
    case 'port_documents_requested':
      return portDocumentsRequested(context as unknown as PortDocumentsRequestedContext);
    case 'port_documents_reminder':
      return portDocumentsReminder(context as unknown as PortDocumentsReminderContext);
    case 'port_documents_completed':
      return portDocumentsCompleted(context as unknown as PortDocumentsCompletedContext);
    default:
      throw new Error(`unknown email template: ${template}`);
  }
}

function invitation(c: UserInvitationContext): RenderedEmail {
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

  return { subject, html: renderHtml(layout), text: renderText(layout) };
}

function discoveryCompleted(c: DiscoveryCompletedContext): RenderedEmail {
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

  return { subject, html: renderHtml(layout), text: renderText(layout) };
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

function portDocumentsRequested(c: PortDocumentsRequestedContext): RenderedEmail {
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
  return { subject, html: renderHtml(layout), text: renderText(layout) };
}

function portDocumentsReminder(c: PortDocumentsReminderContext): RenderedEmail {
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
  return { subject, html: renderHtml(layout), text: renderText(layout) };
}

function portDocumentsCompleted(c: PortDocumentsCompletedContext): RenderedEmail {
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
  return { subject, html: renderHtml(layout), text: renderText(layout) };
}
