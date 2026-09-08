/**
 * Branded shell for every outgoing email. Table-based, all CSS inline, palette
 * lifted from the web app (`apps/web/src/theme.ts` brand ramp 80/90) so mail
 * matches the site.
 */

export interface LayoutInput {
  /** hidden preheader text shown in the inbox preview line */
  previewText: string;
  heading: string;
  /** body paragraphs, rendered before the callout / CTA */
  intro: string[];
  /** optional highlighted block, e.g. a one-time password */
  callout?: { label: string; value: string };
  cta?: { label: string; url: string };
  /** body paragraphs after the CTA */
  outro?: string[];
}

const BRAND = '#4657D2';
const ACCENT = '#5B5FC7';
const TEXT = '#242424';
const MUTED = '#616161';
const BG = '#f5f5f5';
const CARD = '#ffffff';
const BORDER = '#e0e0e0';
const CALLOUT_BG = '#f0f0ff';
const CALLOUT_BORDER = '#d6d6f5';
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(s: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${TEXT};">${esc(s)}</p>`;
}

export function renderHtml(input: LayoutInput): string {
  const intro = input.intro.map(paragraph).join('');
  const outro = (input.outro ?? []).map(paragraph).join('');

  const callout = input.callout
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">
         <tr><td style="background:${CALLOUT_BG};border:1px solid ${CALLOUT_BORDER};border-radius:6px;padding:14px 16px;">
           <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">${esc(
             input.callout.label,
           )}</div>
           <div style="font-family:${MONO};font-size:18px;font-weight:600;color:${TEXT};letter-spacing:1px;word-break:break-all;">${esc(
             input.callout.value,
           )}</div>
         </td></tr>
       </table>`
    : '';

  const cta = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;">
         <tr><td style="border-radius:6px;background:${ACCENT};">
           <a href="${esc(input.cta.url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(
             input.cta.label,
           )}</a>
         </td></tr>
       </table>
       <p style="margin:0 0 14px;font-size:12px;line-height:1.6;color:${MUTED};">If the button does not work, copy this link into your browser:<br>${esc(
         input.cta.url,
       )}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};">
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">${esc(
    input.previewText,
  )}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:8px;overflow:hidden;font-family:${FONT};">
        <tr><td style="background:${BRAND};padding:20px 32px;">
          <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:.2px;">Teams Voice Migration Factory</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 18px;font-size:20px;font-weight:600;color:${TEXT};">${esc(
            input.heading,
          )}</h1>
          ${intro}
          ${callout}
          ${cta}
          ${outro}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid ${BORDER};">
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5;">Automated message from Teams Voice Migration Factory. Please do not reply to this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderText(input: LayoutInput): string {
  const lines: string[] = ['Teams Voice Migration Factory', '', input.heading, ''];
  for (const p of input.intro) lines.push(p, '');
  if (input.callout) lines.push(`${input.callout.label}: ${input.callout.value}`, '');
  if (input.cta) lines.push(`${input.cta.label}: ${input.cta.url}`, '');
  for (const p of input.outro ?? []) lines.push(p, '');
  lines.push('--', 'Automated message from Teams Voice Migration Factory. Please do not reply.');
  return lines.join('\n');
}
