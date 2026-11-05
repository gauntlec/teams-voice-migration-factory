import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  SimpleField,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  TextWrappingType,
  VerticalAlign,
  VerticalPositionRelativeFrom,
  WidthType,
} from 'docx';
import { noteLine, type HandoverBlock, type HandoverSectionContent } from '@tvmf/shared';
import { VOX_TILE_PNG_BASE64 } from '../deployment/assets/vox-tile';
import { bannerPng } from '../branding/banner-png';
import { VOXSHIFT_DOCUMENT_BRAND, type DocumentBrand } from '../branding/document-branding.service';

/**
 * The Service Hand-Over Pack as a Word document, laid out like the corrected AT&T pack (Hauppauge, V1.18.1, 5 Nov 2026):
 *
 * - Front page: the brand's banner and logo, the customer, the project and the site in large type, and the document details
 *   in a label/value table. No running header or footer of its own beyond the footer notice.
 * - Every other page: the brand's logo on the left, "<brand> / Service Hand-Over Pack" in the middle and the customer's logo
 *   on the right, over a rule; the footer carries the confidentiality notice, "Page X of Y", the version and the copyright.
 * - Calibri 10pt text; numbered Calibri Light headings (1., 1.1) in blue; a table of contents; every table captioned
 *   "Table N – …" with Word's own numbering (SEQ Table), so the numbers can't repeat or skip.
 * - Tables: a navy header row (repeated on every page) in white bold, thin black borders, white rows, and column widths set per
 *   column so long values (UPNs, names) get the room and short ones (site, status) don't waste it.
 *
 * The colours are the same for every brand (navy tables, blue headings), as agreed; the brand shows in the banner, the logos,
 * the header and the footer.
 */
const FONT = 'Calibri';
const HEADING_FONT = 'Calibri Light';
const NAVY = '002060';
const HEADING_BLUE = '2F5496';
const CAPTION_GREY = '44546A';
const SITE_ORANGE = 'ED7D31';
const INK = '000000';
const BODY = 20; // 10pt
const SMALL = 16; // 8pt

export type { HandoverSectionContent };

export interface HandoverSectionData {
  key: string;
  title: string;
  content: HandoverSectionContent;
}

export interface HandoverDocumentInput {
  /** whose branding the pack carries (DocumentBrandingService); Voxshift's when not given */
  brand?: DocumentBrand;
  /** the customer's own logo, for the right of the page header (whichever branding the pack carries) */
  customerLogo?: DocumentBrand['logo'];
  tenantName: string;
  /** "AT&T Global Teams Project" - the cover's second line; left out when not given */
  projectName?: string | null;
  /** the cover's "Site: …" line: one site's name, or "All sites" */
  siteLabel?: string;
  /** US Letter for a pack whose sites are all in the US or Canada, A4 otherwise */
  pageSize?: 'letter' | 'a4';
  version: number;
  generatedBy: string;
  generatedAt: Date;
  /** Which sites the pack covers, e.g. "All sites" or "DAL01, LON02". */
  scope: string;
  sections: HandoverSectionData[];
  /** When Discovery last read Teams - what "live" in the as-built sections means. Null = never. */
  liveAsOf: Date | null;
  /** A draft is marked DRAFT throughout; an issued pack says who issued it and when. */
  status: { kind: 'draft' } | { kind: 'issued'; issuedBy: string; issuedAt: Date };
}

/** Page sizes in twentieths of a point, with the 1-inch margins of the template. */
const PAGES = { letter: { width: 12240, height: 15840 }, a4: { width: 11906, height: 16838 } };
const MARGIN = 1440;

/**
 * How much room each column gets, relative to the others in its table - taken from the corrected pack, by column title.
 * A column not listed gets 1.
 */
const COLUMN_WEIGHT: Record<string, number> = {
  UPN: 3.2,
  'User Principal Name (UPN)': 3.2,
  'Display name': 2,
  Name: 3,
  Number: 1.9,
  'Phone number': 1.6,
  Status: 0.95,
  'Assigned to (in Teams)': 4.2,
  Site: 0.95,
  'Site code': 1.2,
  Carrier: 1.9,
  'Number type': 1.1,
  'Voice routing policy': 1.6,
  'Calling policy': 1.6,
  'IP phone policy': 1.4,
  Voicemail: 1,
  'Last changed by Voxshift': 1.5,
  'Device model': 1.4,
  Language: 1.05,
  'Time zone': 2.15,
  'Resource accounts': 1.8,
  'Routing method': 1.2,
  'Alert time (s)': 0.9,
  Agents: 2.2,
  Overflow: 1.3,
  Timeout: 1.3,
  'No agents': 1.3,
  Kind: 1.2,
  Email: 2.4,
  Members: 2.2,
  Owners: 2,
  Scope: 1.4,
  Subnet: 1.55,
  Mask: 1,
  VLAN: 1.25,
  Type: 1.6,
  Location: 2,
  Address: 2.6,
  'Country / Region': 1.3,
  'Site contact(s)': 2.4,
  'Target go-live': 1.2,
  Note: 3,
  Item: 2.4,
  'What differs from the design': 3.6,
};

/** What an empty section says - a sentence, as the template does, not a bare "nothing". */
const EMPTY_TEXT: Record<string, string> = {
  site_information: 'No site information was recorded.',
  phone_numbers: 'No phone numbers were recorded for the site.',
  teams_users: 'No Teams users were enabled.',
  common_area_phones: 'No common area phones were deployed.',
  analogue_phones: 'No analogue phones were deployed.',
  paging: 'No paging was deployed.',
  auto_attendants: 'No auto attendants were deployed.',
  call_queues: 'No call queues were created.',
  resource_accounts: 'No resource accounts were created.',
  voicemail_groups: 'No voicemail groups were deployed.',
  network_data: 'No network data was recorded.',
  not_yet_live: 'Everything designed is live in Teams.',
  outstanding_actions: 'There are no outstanding actions.',
};

/** Each table's caption: "Table N – <this>". */
const CAPTION: Record<string, string> = {
  site_information: 'Site Information Table',
  phone_numbers: 'Phone Numbers Table',
  teams_users: "Teams 'User' Table",
  common_area_phones: 'Common Area Phones Table',
  analogue_phones: 'Analogue Phones Table',
  auto_attendants: 'Auto Attendants Information Table',
  call_queues: 'Call Queues Information Table',
  resource_accounts: 'Resource Accounts Information Table',
  voicemail_groups: 'Voicemail Groups Table',
  network_data: 'Network Data Table',
  not_yet_live: "'Designed but Not Yet Live' Table",
};

/** "13 October 2026" */
const longDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const text = (t: string, o: { bold?: boolean; italics?: boolean; color?: string; size?: number; font?: string } = {}) =>
  new TextRun({ text: t, bold: o.bold, italics: o.italics, color: o.color ?? INK, size: o.size ?? BODY, font: o.font ?? FONT });

const thin = { style: BorderStyle.SINGLE, size: 4, color: INK };
const borders = { top: thin, bottom: thin, left: thin, right: thin };
const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder };

/** The logo scaled to fit a box, keeping its shape. */
function fit(w: number, h: number, maxW: number, maxH: number) {
  const k = Math.min(maxW / (w || maxW), maxH / (h || maxH));
  return { width: Math.max(1, Math.round((w || maxW) * k)), height: Math.max(1, Math.round((h || maxH) * k)) };
}

function logoRun(logo: NonNullable<DocumentBrand['logo']>, maxW: number, maxH: number) {
  return new ImageRun({ type: logo.type, data: logo.data, transformation: fit(logo.width, logo.height, maxW, maxH) });
}

/** The brand's mark: its logo, or Voxshift's tile. */
function brandMark(brand: DocumentBrand, maxW: number, maxH: number) {
  if (brand.logo) return logoRun(brand.logo, maxW, maxH);
  const s = Math.min(maxW, maxH);
  return new ImageRun({ type: 'png', data: Buffer.from(VOX_TILE_PNG_BASE64, 'base64'), transformation: { width: s, height: s } });
}

function cell(children: Paragraph[], o: { width: number; fill?: string; header?: boolean; columnSpan?: number }) {
  return new TableCell({
    width: { size: o.width, type: WidthType.DXA },
    columnSpan: o.columnSpan,
    borders,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 30, bottom: 30, left: 100, right: 100 },
    shading: { fill: o.fill ?? 'FFFFFF', type: ShadingType.CLEAR, color: 'auto' },
    children,
  });
}
const cellText = (t: string, o: { header?: boolean; size?: number } = {}) =>
  new Paragraph({ spacing: { before: 0, after: 0 }, children: [text(t, { ...(o.header ? { bold: true, color: 'FFFFFF' } : {}), size: o.size ?? BODY })] });

/** Column widths that add up to the text width, shared out by COLUMN_WEIGHT. */
function columnWidths(columns: string[], total: number): number[] {
  const w = columns.map((c) => COLUMN_WEIGHT[c] ?? 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => Math.floor((x / sum) * total));
  out[out.length - 1]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** A data table in the template's style: navy header row repeated on every page, thin borders, white rows, fixed widths. */
function dataTable(columns: string[], rows: string[][], total: number): Table {
  const widths = columnWidths(columns, total);
  // a wide table (more than seven columns) steps down to 8pt so its words don't break mid-word
  const size = columns.length > 7 ? SMALL : BODY;
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: columns.map((c, i) => cell([cellText(c, { header: true, size })], { width: widths[i]!, fill: NAVY })) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: columns.map((_, i) => cell([cellText(r[i] || '—', { size })], { width: widths[i]! })) })),
    ],
  });
}

/** A value cell's lines: a value with line breaks (several contacts, several agents) is one paragraph per line. */
const valueLines = (v: string) => (v || '—').split('\n').map((l) => cellText(l));

/** A label/value table: navy labels down the left (the cover's document details, the template's Site Information). */
function labelTable(rows: [string, string][], total: number, labelShare = 0.43): Table {
  const left = Math.round(total * labelShare);
  const widths = [left, total - left];
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: rows.map(([k, v]) => new TableRow({ cantSplit: true, children: [cell([cellText(k, { header: true })], { width: widths[0]!, fill: NAVY }), cell(valueLines(v), { width: widths[1]! })] })),
  });
}

/** Label/value cards two across (the template's Call Queues): label | value | label | value, a card per pair of columns. */
function cardTables(cards: [string, string][][], total: number): Table[] {
  const widths = [0.16, 0.335, 0.15, 0.355].map((f) => Math.round(total * f));
  widths[3]! += total - widths.reduce((a, b) => a + b, 0);
  const out: Table[] = [];
  for (let i = 0; i < cards.length; i += 2) {
    const a = cards[i]!;
    const b = cards[i + 1];
    const n = Math.max(a.length, b?.length ?? 0);
    out.push(
      new Table({
        width: { size: total, type: WidthType.DXA },
        columnWidths: widths,
        layout: TableLayoutType.FIXED,
        rows: Array.from({ length: n }, (_, r) => {
          const half = (c: [string, string][] | undefined, w: number) =>
            c?.[r]
              ? [cell([cellText(c[r]![0], { header: true })], { width: widths[w]!, fill: NAVY }), cell(valueLines(c[r]![1]), { width: widths[w + 1]! })]
              : [cell([cellText('')], { width: widths[w]! }), cell([cellText('')], { width: widths[w + 1]! })];
          return new TableRow({ cantSplit: true, children: [...half(a, 0), ...half(b, 2)] });
        }),
      }),
    );
    // a little room between one pair of cards and the next
    if (i + 2 < cards.length) out.push(new Table({ width: { size: total, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ height: { value: 160, rule: 'exact' as never }, children: [new TableCell({ borders: noBorders, children: [new Paragraph('')] })] })] }));
  }
  return out;
}

/** Outstanding Actions: Task Ref (<section>.<n>, grey), Description, Owner and Action - the template's table. */
function actionsTable(items: { description: string; owner: string }[], section: number, total: number): Table {
  const widths = [0.107, 0.605].map((f) => Math.round(total * f));
  widths.push(total - widths[0]! - widths[1]!);
  const head = ['Task Ref', 'Description', 'Owner and Action'];
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell([cellText(h, { header: true })], { width: widths[i]!, fill: NAVY })) }),
      ...items.map(
        (a, i) =>
          new TableRow({
            cantSplit: true,
            children: [cell([cellText(`${section}.${i + 1}`)], { width: widths[0]!, fill: 'D9D9D9' }), cell([cellText(a.description)], { width: widths[1]! }), cell([cellText(a.owner || '—')], { width: widths[2]! })],
          }),
      ),
    ],
  });
}

/**
 * "Table N – <caption>": a Word SEQ Table field (so Word keeps the numbers in order if tables are added or removed) holding
 * the number already, so it shows in any viewer before Word updates it.
 */
function caption(n: number, label: string): Paragraph {
  return new Paragraph({ style: 'Caption', children: [new TextRun({ text: 'Table ' }), new SimpleField('SEQ Table \\* ARABIC', String(n)), new TextRun({ text: ` – ${label}` })] });
}

const body = (t: string, bold = false, keepNext = false) => new Paragraph({ spacing: { after: 120 }, keepNext, children: [text(t, { bold })] });
const h1 = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_1, numbering: { reference: 'headings', level: 0 }, children: [new TextRun(t)] });
const h2 = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, numbering: { reference: 'headings', level: 1 }, children: [new TextRun(t)] });
/** A bullet; an item starting with two spaces is a second-level bullet (the template's "o" items). */
const bullet = (t: string) => new Paragraph({ spacing: { after: 0 }, numbering: { reference: 'bullets', level: t.startsWith('  ') ? 1 : 0 }, children: [text(t.trim())] });

/** Paragraph lines as written in a note: "## " is a numbered sub-heading, "- " a bullet, anything else a paragraph. */
function noteParagraphs(lines: string[]): Paragraph[] {
  return lines.map((l) => {
    const n = noteLine(l);
    return n.kind === 'heading' ? h2(n.text) : n.kind === 'bullet' ? bullet(n.text) : body(n.text);
  });
}

function sectionBody(section: HandoverSectionData, total: number, nextTable: () => number, number: number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [h1(section.title)];
  const { content } = section;
  const captionFor = (label?: string) => caption(nextTable(), label ?? CAPTION[section.key] ?? `${section.title} Table`);
  if (content.kind === 'placeholder') return [...out, new Paragraph({ spacing: { after: 120 }, children: [text(content.note, { italics: true, color: CAPTION_GREY })] })];
  if (content.kind === 'paragraphs') {
    if (content.paragraphs.length === 0) return [...out, body(EMPTY_TEXT[section.key] ?? 'Nothing recorded.')];
    return [...out, ...noteParagraphs(content.paragraphs)];
  }
  if (content.kind === 'blocks') {
    for (const b of content.blocks) out.push(...blockBody(b, total, captionFor, number));
    return out;
  }
  if (content.rows.length === 0) return [...out, body(EMPTY_TEXT[section.key] ?? 'Nothing recorded.')];
  return [...out, dataTable(content.columns, content.rows, total), captionFor()];
}

function blockBody(b: HandoverBlock, total: number, captionFor: (label?: string) => Paragraph, section: number): (Paragraph | Table)[] {
  switch (b.kind) {
    case 'heading':
      return [h2(b.title)];
    case 'text': {
      // a lead-in sentence stays on the page with the table or list it introduces
      const n = noteLine(b.text);
      return [n.kind === 'text' ? body(n.text, !!b.bold, true) : noteParagraphs([b.text])[0]!];
    }
    case 'bullets':
      return [...b.items.map(bullet), new Paragraph({ spacing: { after: 120 }, children: [] })];
    case 'table': {
      if (b.rows.length === 0) return [body('None.')];
      const width = Math.round(total * Math.min(1, Math.max(0.3, b.share ?? 1)));
      return [dataTable(b.columns, b.rows, width), captionFor(b.caption)];
    }
    case 'labels':
      return [labelTable(b.rows, Math.round(total * (b.title ? 0.65 : 1)), b.title ? 0.49 : 0.33), captionFor(b.caption)];
    case 'cards':
      return [...cardTables(b.cards, total), captionFor(b.caption)];
    case 'actions':
      return [actionsTable(b.items, section, total), ...(b.caption ? [captionFor(b.caption)] : [])];
  }
}

@Injectable()
export class HandoverDocumentService {
  async build(input: HandoverDocumentInput): Promise<Buffer> {
    const brand = input.brand ?? VOXSHIFT_DOCUMENT_BRAND;
    const page = PAGES[input.pageSize ?? 'a4'];
    const total = page.width - 2 * MARGIN;
    const draft = input.status.kind === 'draft';
    const author = brand.name;
    const versionLabel = `${input.version}`;
    const year = (input.status.kind === 'issued' ? input.status.issuedAt : input.generatedAt).getUTCFullYear();

    // Running header (every page but the first): brand logo | brand / title | customer logo, over a rule.
    const third = Math.round(total / 3);
    const header = new Header({
      children: [
        new Table({
          width: { size: total, type: WidthType.DXA },
          columnWidths: [third, total - 2 * third, third],
          layout: TableLayoutType.FIXED,
          borders: noBorders,
          rows: [
            new TableRow({
              children: [
                new TableCell({ borders: noBorders, verticalAlign: VerticalAlign.CENTER, width: { size: third, type: WidthType.DXA }, children: [new Paragraph({ children: [brandMark(brand, 70, 52)] })] }),
                new TableCell({
                  borders: noBorders,
                  verticalAlign: VerticalAlign.CENTER,
                  width: { size: total - 2 * third, type: WidthType.DXA },
                  children: [
                    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [text(author, { bold: true })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [text(draft ? 'Service Hand-Over Pack  ·  DRAFT' : 'Service Hand-Over Pack', { bold: draft })] }),
                  ],
                }),
                new TableCell({
                  borders: noBorders,
                  verticalAlign: VerticalAlign.CENTER,
                  width: { size: third, type: WidthType.DXA },
                  children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: input.customerLogo ? [logoRun(input.customerLogo, 110, 40)] : [text(input.tenantName, { bold: true })] })],
                }),
              ],
            }),
          ],
        }),
        new Paragraph({ spacing: { after: 0 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: INK, space: 1 } }, children: [] }),
      ],
    });

    // Footer (every page): the confidentiality notice, Page X of Y, the version and the copyright.
    const footerParagraphs = () => [
      new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: INK, space: 1 } }, alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [text('CONFIDENTIAL INFORMATION', { bold: true, size: SMALL })] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [text('This document is for use by authorized employees of the parties hereto only and is not for general distribution within or outside their companies.', { italics: true, size: SMALL })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 0 },
        children: [
          text('Page ', { size: SMALL }),
          new TextRun({ children: [PageNumber.CURRENT], size: SMALL, font: FONT, color: INK }),
          text(' of ', { size: SMALL }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: SMALL, font: FONT, color: INK }),
        ],
      }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [text(`Version: ${versionLabel}${draft ? ' (draft)' : ''}`, { size: SMALL })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [text(`© ${year} ${author}. All rights reserved.`, { bold: true, size: SMALL })] }),
    ];
    const footer = new Footer({ children: footerParagraphs() });
    const firstFooter = new Footer({ children: footerParagraphs() });

    // Front page: the banner across the top of the page, the brand's logo, then the customer, project and site.
    const banner = new Paragraph({
      children: [
        new ImageRun({
          type: 'png',
          data: bannerPng(brand.palette),
          transformation: { width: Math.round((page.width / 20) * (96 / 72)), height: Math.round(((page.width / 20) * (96 / 72)) / 6) },
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
            wrap: { type: TextWrappingType.TOP_AND_BOTTOM },
            behindDocument: true,
          },
        }),
      ],
    });
    const big = (t: string, color = INK) => new Paragraph({ spacing: { after: 0 }, children: [text(t, { bold: true, size: 72, color })] });
    const cover: (Paragraph | Table)[] = [
      banner,
      new Paragraph({ spacing: { before: 900, after: 1000 }, children: [brandMark(brand, 130, 130)] }),
      big(input.tenantName),
      ...(input.projectName ? [big(input.projectName)] : []),
      new Paragraph({ spacing: { after: 360 }, children: [text(`Site: ${input.siteLabel ?? input.scope}`, { bold: true, size: 72, color: SITE_ORANGE })] }),
      labelTable(
        [
          ['Document Title', 'Service Hand-Over Pack'],
          ['Document Author', author],
          ['Document Status', input.status.kind === 'issued' ? 'Issued' : 'DRAFT - not for distribution'],
          ['Document Version', `Version ${versionLabel}`],
          ['Date', longDate(input.status.kind === 'issued' ? input.status.issuedAt : input.generatedAt)],
          ...(input.status.kind === 'issued' ? ([['Issued by', input.status.issuedBy]] as [string, string][]) : ([['Prepared by', input.generatedBy]] as [string, string][])),
          ['Checked against Teams', input.liveAsOf ? longDate(input.liveAsOf) : 'Not yet - run Discovery before issuing'],
        ],
        total,
      ),
      new Paragraph({ children: [new PageBreak()] }),
      new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-2' }),
      new Paragraph({ children: [new PageBreak()] }),
    ];

    // An issued pack leaves out the engineers' checklist of what isn't live yet (drafts only).
    const sections = input.sections.filter((s) => !(input.status.kind === 'issued' && s.key === 'not_yet_live'));
    let tables = 0;
    const content = sections.flatMap((s, i) => sectionBody(s, total, () => ++tables, i + 1));

    const doc = new Document({
      creator: author,
      title: `${input.tenantName} - Service Hand-Over Pack`,
      // Word fills in the table of contents and the table numbers when the document is opened.
      features: { updateFields: true },
      styles: {
        default: {
          document: { run: { font: FONT, size: BODY }, paragraph: { spacing: { after: 120, line: 259 } } },
          heading1: { run: { font: HEADING_FONT, size: 32, color: HEADING_BLUE }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true, keepLines: true } },
          heading2: { run: { font: HEADING_FONT, size: 26, color: HEADING_BLUE }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true, keepLines: true } },
        },
        paragraphStyles: [
          {
            id: 'Caption',
            name: 'Caption',
            basedOn: 'Normal',
            next: 'Normal',
            quickFormat: true,
            run: { font: FONT, size: 18, italics: true, bold: true, color: CAPTION_GREY },
            paragraph: { spacing: { before: 60, after: 240 } },
          },
        ],
      },
      numbering: {
        config: [
          {
            reference: 'bullets',
            levels: [
              { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 360 } } } },
              { level: 1, format: LevelFormat.BULLET, text: 'o', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 360 } }, run: { font: 'Courier New' } } },
            ],
          },
          {
            reference: 'headings',
            levels: [
              { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 432, hanging: 432 } } } },
              { level: 1, format: LevelFormat.DECIMAL, text: '%1.%2', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 576, hanging: 576 } } } },
            ],
          },
        ],
      },
      sections: [
        {
          properties: {
            page: { size: page, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 500, footer: 400 } },
            titlePage: true,
          },
          headers: { default: header, first: new Header({ children: [new Paragraph('')] }) },
          footers: { default: footer, first: firstFooter },
          children: [...cover, ...content, new Paragraph({ spacing: { before: 480 }, alignment: AlignmentType.CENTER, children: [text('End of Document', { size: 32, color: HEADING_BLUE })] })],
        },
      ],
    });

    return Packer.toBuffer(doc);
  }
}
