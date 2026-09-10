import type {
  DiscoveryCompletedContext,
  EmailTemplate,
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
