import nodemailer, { type Transporter } from 'nodemailer';

const FROM_NAME = process.env.MAIL_FROM_NAME || 'Teams Voice Migration Factory';
const FROM_ADDR = process.env.MAIL_FROM || 'no-reply@voxshift.io';

/** Mail is only actually sent when an SMTP relay is configured. */
export const mailerConfigured = !!process.env.SMTP_HOST;

let transporter: Transporter | null = null;

function transport(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
        : undefined,
    });
  }
  return transporter;
}

export interface OutgoingMail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
}

/** Send one email. Throws on any SMTP failure so the caller can retry. */
export async function sendMail(m: OutgoingMail): Promise<string> {
  const info = await transport().sendMail({
    from: `"${FROM_NAME}" <${FROM_ADDR}>`,
    to: m.toName ? `"${m.toName}" <${m.to}>` : m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
  });
  return info.messageId;
}
