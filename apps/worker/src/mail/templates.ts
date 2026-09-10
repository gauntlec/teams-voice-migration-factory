import type { EmailTemplate, UserInvitationContext } from '@tvmf/shared';
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
