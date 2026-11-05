import PDFDocument from 'pdfkit';
import { figureChange, figureText, goLiveDateLabel, reportPeriodLabel, utcDay, type ReportCell, type ReportDocument, type ReportSection } from '@tvmf/shared';

/**
 * Any report (packages/shared/src/reports.ts) as a branded A4 PDF, drawn from the same sections the Reports page and the
 * Excel export use (docs/INSIGHTS.md, step 4). pdfkit draws it directly - no browser - in the Voxshift look: the mark and
 * wordmark, brand purple for hierarchy, a tinted callout for the headline, purple table headings, and a footer with
 * page numbers.
 *
 * The PDF uses the standard Helvetica fonts, so no font files ship with the app. They cover Western European text; any
 * other character is shown as "?" (`pdfText`).
 */

const BRAND = '#4657D2';
const ACCENT = '#5B5FC7';
const LIFT = '#C3C7F6';
const TINT = '#EEEFFD';
const ZEBRA = '#F7F7FB';
const INK = '#242424';
const MUTED = '#616161';
const RULE = '#E3E3EC';
const GOOD = '#107C10';
const BAD = '#C50F1F';

const A4 = { width: 595.28, height: 841.89 };
const M = 44; // margin
const FOOT = 30; // space kept for the footer
/** A report with a table wider than this prints in landscape. */
const LANDSCAPE_COLUMNS = 6;

// The characters Helvetica's WinAnsi encoding has beyond Latin-1, by code point.
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);

/** Text the standard fonts can draw: arrows become + and -, anything else outside WinAnsi becomes "?". */
export function pdfText(v: unknown): string {
  const s = String(v ?? '').replace(/▲ ?/g, '+').replace(/▼ ?/g, '-').replace(/\r\n?/g, '\n');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.has(c) ? ch : '?';
  }
  return out;
}

const cellText = (v: ReportCell) => (v === null || v === '' ? '-' : typeof v === 'number' ? v.toLocaleString('en-GB') : pdfText(v));
/** A very long cell (a full PowerShell message) is cut in the PDF; the Excel export keeps it whole. */
const MAX_CELL = 600;

export function renderReportPdf(doc: ReportDocument, customer: string, preparedAt = new Date()): Promise<Buffer> {
  const landscape = doc.sections.some((x) => x.kind === 'table' && x.columns.length > LANDSCAPE_COLUMNS);
  const PAGE = landscape ? { width: A4.height, height: A4.width } : A4;
  const W = PAGE.width - 2 * M;
  const pdf = new PDFDocument({
    size: 'A4',
    layout: landscape ? 'landscape' : 'portrait',
    margins: { top: M, bottom: M, left: M, right: M },
    bufferPages: true,
    info: { Title: `${doc.title} - ${customer}`, Author: 'Voxshift', Subject: reportPeriodLabel(doc.period), Creator: 'Voxshift' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  const bottom = () => PAGE.height - M - FOOT;
  const ensure = (h: number) => {
    if (pdf.y + h > bottom()) {
      pdf.addPage();
      pdf.y = M;
    }
  };

  // ---- header: the mark (four ascending bars, the last lifted and nudged forward) and the wordmark
  const mark = (x: number, y: number, size: number) => {
    const k = size / 28;
    const bar = (bx: number, by: number, bh: number, color: string) => pdf.roundedRect(x + bx * k, y + by * k, 4.5 * k, bh * k, 2.25 * k).fill(color);
    bar(1, 14, 13, BRAND);
    bar(7.5, 10, 17, BRAND);
    bar(14, 6, 21, BRAND);
    bar(21.5, 1, 16, ACCENT);
  };
  mark(M, M - 2, 20);
  pdf.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('vox', M + 26, M + 2, { continued: true }).font('Helvetica').fillColor(ACCENT).text('shift');
  pdf
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(pdfText(`Prepared ${goLiveDateLabel(utcDay(preparedAt))} for ${customer}`), M, M + 5, { width: W, align: 'right' });
  pdf.moveTo(M, M + 26).lineTo(M + W, M + 26).lineWidth(0.8).strokeColor(LIFT).stroke();

  // ---- title
  pdf.y = M + 40;
  pdf.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(pdfText(doc.title), M, pdf.y, { width: W });
  const sub = `${reportPeriodLabel(doc.period)}${doc.comparedWith ? `  ·  compared with ${reportPeriodLabel(doc.comparedWith)}` : ''}`;
  pdf.moveDown(0.15).font('Helvetica-Bold').fontSize(10).fillColor(BRAND).text(pdfText(sub), { width: W });
  pdf.moveDown(0.9);

  for (const section of doc.sections) drawSection(section);

  // ---- footer on every page
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    const y = PAGE.height - M - 10;
    pdf.moveTo(M, y - 6).lineTo(M + W, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    pdf.text(pdfText(`Voxshift  ·  www.voxshift.io  ·  ${doc.title}  ·  ${customer}`), M, y, { width: W * 0.75, lineBreak: false });
    pdf.text(`Page ${i + 1} of ${range.count}`, M, y, { width: W, align: 'right', lineBreak: false });
  }
  pdf.end();
  return done;

  /** `t` cut to fit `width` in the current font, ending "..." when cut. */
  function fit(t: string, width: number): string {
    if (pdf.widthOfString(t) <= width) return t;
    let s2 = t;
    while (s2.length > 1 && pdf.widthOfString(`${s2}...`) > width) s2 = s2.slice(0, -1);
    return `${s2.trimEnd()}...`;
  }

  function heading(title: string) {
    ensure(40);
    pdf.font('Helvetica-Bold').fontSize(9).fillColor('#354BC0').text(pdfText(title.toUpperCase()), M, pdf.y, { width: W, characterSpacing: 0.6 });
    pdf.moveDown(0.35);
  }

  function drawSection(section: ReportSection) {
    if (section.kind === 'headline') {
      const body = section.sentences.map(pdfText).join(' ');
      pdf.font('Helvetica-Bold').fontSize(11.5);
      const th = pdf.heightOfString(pdfText(section.title), { width: W - 28 });
      pdf.font('Helvetica').fontSize(10);
      const bh = body ? pdf.heightOfString(body, { width: W - 28, lineGap: 2 }) : 0;
      const h = th + bh + 26;
      ensure(h + 10);
      const y = pdf.y;
      pdf.rect(M, y, W, h).fill(TINT);
      pdf.rect(M, y, 4, h).fill(BRAND);
      pdf.font('Helvetica-Bold').fontSize(11.5).fillColor(INK).text(pdfText(section.title), M + 16, y + 11, { width: W - 28 });
      if (body) pdf.font('Helvetica').fontSize(10).fillColor(INK).text(body, M + 16, y + 15 + th, { width: W - 28, lineGap: 2 });
      pdf.y = y + h + 16;
      return;
    }
    if (section.kind === 'note') {
      ensure(20);
      pdf.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(pdfText(section.text), M, pdf.y, { width: W });
      pdf.moveDown(0.8);
      return;
    }
    if (section.kind === 'figures') {
      heading(section.title);
      const cols = section.figures.length <= 4 ? section.figures.length : 3;
      const gap = 8;
      const cw = (W - gap * (cols - 1)) / cols;
      const ch = 58;
      for (let i = 0; i < section.figures.length; i += cols) {
        ensure(ch + gap);
        const y = pdf.y;
        section.figures.slice(i, i + cols).forEach((f, j) => {
          const x = M + j * (cw + gap);
          pdf.roundedRect(x, y, cw, ch, 4).lineWidth(0.6).strokeColor(RULE).stroke();
          pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(fit(pdfText(f.label), cw - 18), x + 9, y + 8, { lineBreak: false });
          pdf.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(fit(pdfText(figureText(f.value, f.unit)), cw - 18), x + 9, y + 20, { lineBreak: false });
          // The change in green or red, then "before ..." and the note in grey.
          const change = figureChange(f);
          let fx = x + 9;
          pdf.fontSize(7.5);
          if (change) {
            const t = pdfText(change.text);
            pdf.font('Helvetica-Bold').fillColor(change.good === null ? MUTED : change.good ? GOOD : BAD).text(t, fx, y + 42, { lineBreak: false });
            fx += pdf.widthOfString(t) + 6;
          }
          const rest = [f.previous !== undefined && f.previous !== null ? `before ${figureText(f.previous, f.unit)}` : null, f.note].filter(Boolean).join('  ·  ');
          if (rest) pdf.font('Helvetica').fillColor(MUTED).text(fit(pdfText(rest), x + cw - 9 - fx), fx, y + 42, { lineBreak: false });
        });
        pdf.y = y + ch + gap;
      }
      pdf.moveDown(0.6);
      return;
    }
    // a table
    heading(`${section.title}${section.rows.length ? ` (${section.rows.length.toLocaleString('en-GB')})` : ''}`);
    if (section.rows.length === 0) {
      pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(section.empty ?? 'Nothing to show.'), M, pdf.y, { width: W });
      pdf.moveDown(0.8);
      return;
    }
    const numeric = new Set(section.numeric ?? []);
    const fs = section.columns.length > 6 ? 7 : 8;
    const pad = 4;
    const text = (r: ReportCell[]) => r.map((v) => {
      const t = cellText(v);
      return t.length > MAX_CELL ? `${t.slice(0, MAX_CELL)}...` : t;
    });
    // Column widths: every column gets at least its longest word (so words never break), then the space left goes to the
    // columns whose text wants more, in proportion.
    const sample = section.rows.slice(0, 300).map(text);
    const longestWord = (t: string) => Math.max(0, ...t.split(/\s+/).map((w) => pdf.widthOfString(w)));
    const need = section.columns.map((c, i) => {
      pdf.font('Helvetica-Bold').fontSize(fs);
      let min = longestWord(pdfText(c));
      let want = pdf.widthOfString(pdfText(c));
      pdf.font('Helvetica').fontSize(fs);
      for (const r of sample) {
        const t = r[i] ?? '';
        min = Math.max(min, Math.min(longestWord(t), 150));
        want = Math.max(want, Math.min(pdf.widthOfString(t), 280));
      }
      return { min: min + 2 * pad + 1, want: Math.max(min, want) + 2 * pad + 1 };
    });
    const sumMin = need.reduce((a, b) => a + b.min, 0);
    const sumWant = need.reduce((a, b) => a + b.want, 0);
    const widths =
      sumWant <= W
        ? need.map((n) => (n.want / sumWant) * W)
        : sumMin >= W
          ? need.map((n) => (n.min / sumMin) * W)
          : need.map((n) => n.min + ((n.want - n.min) / (sumWant - sumMin)) * (W - sumMin));
    const rowHeight = (cells: string[], bold: boolean) => {
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
      return Math.max(...cells.map((c, i) => pdf.heightOfString(c, { width: widths[i]! - 2 * pad }))) + 2 * pad;
    };
    const drawRow = (cells: string[], header: boolean, zebra: boolean) => {
      const h = rowHeight(cells, header);
      const y = pdf.y;
      if (header) pdf.rect(M, y, W, h).fill(BRAND);
      else if (zebra) pdf.rect(M, y, W, h).fill(ZEBRA);
      let x = M;
      cells.forEach((c, i) => {
        pdf
          .font(header ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(fs)
          .fillColor(header ? '#FFFFFF' : INK)
          .text(c, x + pad, y + pad, { width: widths[i]! - 2 * pad, align: numeric.has(i) ? 'right' : 'left' });
        x += widths[i]!;
      });
      if (!header) pdf.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.4).strokeColor(RULE).stroke();
      pdf.y = y + h;
    };
    const head = section.columns.map(pdfText);
    ensure(rowHeight(head, true) + 20);
    drawRow(head, true, false);
    section.rows.forEach((r, i) => {
      const cells = text(r);
      const h = rowHeight(cells, false);
      if (pdf.y + h > bottom()) {
        pdf.addPage();
        pdf.y = M;
        drawRow(head, true, false);
      }
      drawRow(cells, false, i % 2 === 1);
    });
    pdf.moveDown(0.4);
    if (section.note) {
      ensure(16);
      pdf.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text(pdfText(section.note), M, pdf.y, { width: W });
    }
    pdf.moveDown(0.9);
  }
}
