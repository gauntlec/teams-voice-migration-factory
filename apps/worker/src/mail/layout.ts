/**
 * Branded shell for every outgoing email. Table-based, all CSS inline, no web
 * fonts or external images — safe from Outlook down to mobile webmail.
 *
 * Brand system (Voxshift brand guidelines / `apps/web/src/theme.ts`):
 *   brand 80  #4657D2  primary — header bar, primary button, eyebrow, links
 *   brand 90  #5B5FC7  accent — the "shift", header strip, footer wordmark
 *   brand 140 #C3C7F6  hairline rules, the lifted equalizer bar
 *   brand 160 #EEEFFD  callout / MessageBar fill
 *   ink       #242424  body text          muted #616161
 * Typeface: Segoe UI stack (Fluent). Monospace: Consolas.
 */

export interface LayoutInput {
  /** hidden preheader text shown in the inbox preview line */
  previewText: string;
  heading: string;
  /** short brand-purple kicker above the heading, e.g. "Account invitation" */
  eyebrow?: string;
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
const RULE = '#C3C7F6';
const TEXT = '#242424';
const MUTED = '#616161';
const PAGE_BG = '#f4f4f8';
const CARD = '#ffffff';
const BORDER = '#e3e3ec';
const CALLOUT_BG = '#eeeffd';
const CALLOUT_BORDER = '#c3c7f6';
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "Consolas, 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, monospace";

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(s: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.62;color:${TEXT};">${esc(s)}</p>`;
}

/** The Voxshift equalizer mark, drawn as a 4-cell table so it survives Outlook. */
function mark(): string {
  const bar = (h: number, lift: number, color: string) =>
    `<td valign="bottom" style="padding:0 3px 0 0;">` +
    `<div style="width:5px;height:${h}px;background:${color};border-radius:2px;font-size:0;line-height:0;margin-bottom:${lift}px;">&nbsp;</div>` +
    `</td>`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:middle;margin-right:11px;"><tr>` +
    bar(10, 0, '#ffffff') +
    bar(15, 0, '#ffffff') +
    bar(20, 0, '#ffffff') +
    bar(14, 7, RULE) +
    `</tr></table>`
  );
}

function wordmark(onDark: boolean): string {
  const vox = onDark ? '#ffffff' : TEXT;
  const shift = onDark ? 'rgba(255,255,255,0.82)' : ACCENT;
  return (
    `<span style="font-size:18px;font-weight:600;letter-spacing:-0.01em;color:${vox};vertical-align:middle;">vox` +
    `<span style="font-weight:400;color:${shift};">shift</span></span>`
  );
}

export function renderHtml(input: LayoutInput): string {
  const intro = input.intro.map(paragraph).join('');
  const outro = (input.outro ?? []).map(paragraph).join('');

  const eyebrow = input.eyebrow
    ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${BRAND};margin:0 0 8px;">${esc(
        input.eyebrow,
      )}</div>`
    : '';

  const callout = input.callout
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;">
         <tr><td style="background:${CALLOUT_BG};border:1px solid ${CALLOUT_BORDER};border-radius:8px;padding:16px 18px;">
           <div style="font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;">${esc(
             input.callout.label,
           )}</div>
           <div style="font-family:${MONO};font-size:19px;font-weight:600;color:${TEXT};letter-spacing:1px;word-break:break-all;">${esc(
             input.callout.value,
           )}</div>
         </td></tr>
       </table>`
    : '';

  const cta = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
         <tr><td style="border-radius:8px;background:${BRAND};">
           <a href="${esc(input.cta.url)}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;font-family:${FONT};">${esc(
             input.cta.label,
           )}</a>
         </td></tr>
       </table>
       <p style="margin:0 0 14px;font-size:12px;line-height:1.6;color:${MUTED};">If the button does not work, copy this link into your browser:<br><span style="color:${BRAND};word-break:break-all;">${esc(
         input.cta.url,
       )}</span></p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">${esc(
    input.previewText,
  )}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:10px;overflow:hidden;font-family:${FONT};">
        <tr><td style="background:${BRAND};padding:22px 32px;border-bottom:3px solid ${ACCENT};">
          ${mark()}${wordmark(true)}
        </td></tr>
        <tr><td style="padding:32px;">
          ${eyebrow}
          <h1 style="margin:0 0 18px;font-size:20px;font-weight:600;line-height:1.3;color:${TEXT};">${esc(
            input.heading,
          )}</h1>
          ${intro}
          ${callout}
          ${cta}
          ${outro}
        </td></tr>
        <tr><td style="padding:20px 32px 24px;border-top:1px solid ${BORDER};background:#fbfbfd;">
          <div style="margin:0 0 6px;">${wordmark(false)}</div>
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5;">Automated message from Voxshift, the Microsoft Teams voice migration platform. Please do not reply to this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderText(input: LayoutInput): string {
  const lines: string[] = ['voxshift'];
  if (input.eyebrow) lines.push(input.eyebrow.toUpperCase());
  lines.push('', input.heading, '');
  for (const p of input.intro) lines.push(p, '');
  if (input.callout) lines.push(`${input.callout.label}: ${input.callout.value}`, '');
  if (input.cta) lines.push(`${input.cta.label}: ${input.cta.url}`, '');
  for (const p of input.outro ?? []) lines.push(p, '');
  lines.push('--', 'Automated message from Voxshift. Please do not reply.');
  return lines.join('\n');
}
