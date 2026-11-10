import { Injectable, Optional } from '@nestjs/common';
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
  Tab,
  TabStopType,
  LeaderType,
  Bookmark,
  BuilderElement,
  InternalHyperlink,
  Run,
  TableRow,
  TextRun,
  TextWrappingType,
  VerticalAlign,
  VerticalPositionRelativeFrom,
  WidthType,
} from 'docx';
import { noteLine, type HandoverApproval, type HandoverBlock, type HandoverHistoryRow, type HandoverSectionContent } from '@tvmf/shared';
import { VOX_TILE_PNG_BASE64 } from '../deployment/assets/vox-tile';
import { columnWidths, wordsFit } from './column-widths';
import { PackPageNumbers, type PackHeading } from './pack-page-numbers';
import { bannerPng } from '../branding/banner-png';
import { VOXSHIFT_DOCUMENT_BRAND, type DocumentBrand } from '../branding/document-branding.service';

/**
 * The Service Hand-Over Pack as a Word document, laid out like the corrected AT&T pack (Hauppauge, V1.18.1, 5 Nov 2026):
 *
 * - Front page: the brand's banner and logo, the customer, the project and the site in large type, and the document details
 *   in a label/value table. No running header or footer of its own beyond the footer notice.
 * - Every other page: the brand's logo on the left, "<brand> / Service Hand-Over Pack" in the middle and the customer's logo
 *   on the right, over a rule; the footer carries the confidentiality notice, "Page X of Y", the version and the copyright.
 * - Calibri 10pt text; numbered Calibri Light headings (1., 1.1) in blue; a table of contents, already filled in; every table captioned
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
  /** the pictures the sections name (call flow diagrams), by stored file id */
  images?: Map<string, Buffer>;
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
  /** the major.minor version printed in the pack ("0.2", "1.0"); the plain number when not given */
  versionLabel?: string;
  /** Approvals & Sign-Off - set when the pack is issued */
  approval?: HandoverApproval | null;
  /** Document Control: this pack's versions so far, oldest first, this one last */
  history?: HandoverHistoryRow[];
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
  not_yet_live: 'No deployment issues were observed.',
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

/** A data table in the template's style: navy header row repeated on every page, thin borders, white rows, fixed widths. */
function dataTable(columns: string[], rows: string[][], total: number): Table {
  // a wide table (more than seven columns), or one whose words won't fit at 10pt, steps down to 8pt so they don't break mid-word
  const size = columns.length > 7 || !wordsFit(columns, rows, total, BODY) ? SMALL : BODY;
  const widths = columnWidths(columns, rows, total, size);
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

/** One card per row, the page's width: label and value, for a card with long values (a call queue). */
function cardTables1(cards: [string, string][][], total: number): Table[] {
  const widths = [Math.round(total * 0.3), total - Math.round(total * 0.3)];
  return cards.map(
    (c) =>
      new Table({
        width: { size: total, type: WidthType.DXA },
        columnWidths: widths,
        layout: TableLayoutType.FIXED,
        rows: c.map(([k, v]) => new TableRow({ cantSplit: true, children: [cell([cellText(k, { header: true })], { width: widths[0]!, fill: NAVY }), cell(valueLines(v), { width: widths[1]! })] })),
      }),
  );
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
function caption(n: number, label: string, kind: 'Table' | 'Figure' = 'Table'): Paragraph {
  return new Paragraph({ style: 'Caption', children: [new TextRun({ text: `${kind} ` }), new SimpleField(`SEQ ${kind} \\* ARABIC`, String(n)), new TextRun({ text: ` – ${label}` })] });
}

const body = (t: string, bold = false, keepNext = false) => new Paragraph({ spacing: { after: 120 }, keepNext, children: [text(t, { bold })] });

/** The pack's numbered headings, in order as they are drawn: the contents page lists them and links to each one. */
class Outline {
  readonly headings: PackHeading[] = [];
  private major = 0;
  private minor = 0;

  private add(level: 1 | 2, number: string, title: string): Bookmark {
    const anchor = `_Toc${this.headings.length + 1}`;
    this.headings.push({ level, number, title, anchor });
    return new Bookmark({ id: anchor, children: [new TextRun(title)] });
  }
  h1(t: string): Paragraph {
    this.major++;
    this.minor = 0;
    return new Paragraph({ heading: HeadingLevel.HEADING_1, numbering: { reference: 'headings', level: 0 }, children: [this.add(1, `${this.major}.`, t)] });
  }
  h2(t: string): Paragraph {
    this.minor++;
    return new Paragraph({ heading: HeadingLevel.HEADING_2, numbering: { reference: 'headings', level: 1 }, children: [this.add(2, `${this.major}.${this.minor}`, t)] });
  }
}

const fieldChar = (type: 'begin' | 'separate' | 'end') => new BuilderElement({ name: 'w:fldChar', attributes: { type: { key: 'w:fldCharType', value: type } } });

/**
 * The contents page: a real Word contents field, so right-click > Update Field still works, already filled in with its result. Nothing
 * asks Word to refresh it on opening, because that makes Word warn about "fields that may refer to other files" (and the warning can't
 * be switched off). Without page numbers (pages is null) the lines still name each section and link to it.
 */
function contentsPage(outline: Outline, pages: Map<string, number> | null, placeholders: boolean, total: number): Paragraph[] {
  const instruction = new BuilderElement({ name: 'w:instrText', attributes: { space: { key: 'xml:space', value: 'preserve' } }, children: [' TOC \\h \\o "1-2" ' as never] });
  const last = outline.headings.length - 1;
  return outline.headings.map((h, i) => {
    const page = pages?.get(h.anchor) ?? (placeholders ? 0 : null);
    return new Paragraph({
      style: h.level === 1 ? 'TOC1' : 'TOC2',
      tabStops: [
        { type: TabStopType.LEFT, position: h.level === 1 ? 440 : 880 },
        { type: TabStopType.RIGHT, position: total, leader: LeaderType.DOT },
      ],
      children: [
        ...(i === 0 ? [new Run({ children: [fieldChar('begin'), instruction, fieldChar('separate')] as never })] : []),
        new InternalHyperlink({ anchor: h.anchor, children: [new TextRun({ children: [h.number, new Tab(), h.title, ...(page === null ? [] : [new Tab(), String(page)])] })] }),
        ...(i === last ? [new Run({ children: [fieldChar('end')] as never })] : []),
      ],
    });
  });
}

/** A bullet; an item starting with two spaces is a second-level bullet (the template's "o" items). */
const bullet = (t: string) => new Paragraph({ spacing: { after: 0 }, numbering: { reference: 'bullets', level: t.startsWith('  ') ? 1 : 0 }, children: [text(t.trim())] });

/** Paragraph lines as written in a note: "## " is a numbered sub-heading, "- " a bullet, anything else a paragraph. */
function noteParagraphs(lines: string[], outline: Outline): Paragraph[] {
  return lines.map((l) => {
    const n = noteLine(l);
    return n.kind === 'heading' ? outline.h2(n.text) : n.kind === 'bullet' ? bullet(n.text) : body(n.text);
  });
}

function sectionBody(section: HandoverSectionData, total: number, next: { table: () => number; figure: () => number }, number: number, images: Map<string, Buffer>, maxImageHeight: number, outline: Outline): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [outline.h1(section.title)];
  const { content } = section;
  const captionFor = (label?: string) => caption(next.table(), label ?? CAPTION[section.key] ?? `${section.title} Table`);
  const figureFor = (label: string) => caption(next.figure(), label, 'Figure');
  if (content.kind === 'placeholder') return [...out, new Paragraph({ spacing: { after: 120 }, children: [text(content.note, { italics: true, color: CAPTION_GREY })] })];
  if (content.kind === 'paragraphs') {
    if (content.paragraphs.length === 0) return [...out, body(EMPTY_TEXT[section.key] ?? 'Nothing recorded.')];
    return [...out, ...noteParagraphs(content.paragraphs, outline)];
  }
  if (content.kind === 'blocks') {
    for (const b of content.blocks) out.push(...blockBody(b, total, captionFor, figureFor, number, images, maxImageHeight, outline));
    return out;
  }
  if (content.rows.length === 0) return [...out, body(EMPTY_TEXT[section.key] ?? 'Nothing recorded.')];
  return [...out, dataTable(content.columns, content.rows, total), captionFor()];
}

function blockBody(b: HandoverBlock, total: number, captionFor: (label?: string) => Paragraph, figureFor: (label: string) => Paragraph, section: number, images: Map<string, Buffer>, maxImageHeight: number, outline: Outline): (Paragraph | Table)[] {
  switch (b.kind) {
    case 'image': {
      const data = images.get(b.fileId);
      if (!data) return [body(`The call flow diagram for ${b.title} isn't available.`)];
      // as wide as the text (twentieths of a point to pixels), and never taller than the page has room for
      const size = fit(b.width, b.height, Math.round((total / 20) * (96 / 72)), maxImageHeight);
      const scale = Math.min(size.width / (b.width || 1), size.height / (b.height || 1));
      return [
        // the caption under the picture names it; without one, the name goes above
        ...(b.caption ? [] : [new Paragraph({ spacing: { before: 120, after: 60 }, keepNext: true, children: [text(b.title, { bold: true })] })]),
        new Paragraph({
          spacing: { before: b.caption ? 120 : 0, after: b.caption ? 60 : 200 },
          keepNext: !!b.caption,
          children: [new ImageRun({ type: 'png', data, transformation: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) }, altText: { title: `Call flow: ${b.title}`, description: `Call flow diagram for ${b.title}`, name: `Call flow ${b.title}` } })],
        }),
        ...(b.caption ? [figureFor(b.caption)] : []),
      ];
    }
    case 'heading':
      return [outline.h2(b.title)];
    case 'text': {
      // a lead-in sentence stays on the page with the table or list it introduces
      const n = noteLine(b.text);
      return [n.kind === 'text' ? body(n.text, !!b.bold, true) : noteParagraphs([b.text], outline)[0]!];
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
      return [...(b.perRow === 1 ? cardTables1(b.cards, total) : cardTables(b.cards, total)), captionFor(b.caption)];
    case 'actions':
      return [actionsTable(b.items, section, total), ...(b.caption ? [captionFor(b.caption)] : [])];
  }
}

@Injectable()
export class HandoverDocumentService {
  /** Lays a pack out to find its page numbers. Without it (a test) the contents page has none. */
  constructor(@Optional() private readonly pageNumbers?: PackPageNumbers) {}

  async build(input: HandoverDocumentInput): Promise<Buffer> {
    if (!this.pageNumbers) return (await this.draw(input, null, false)).docx;
    // Drawn once with a stand-in page number on every contents line, so the contents takes the same room, to see where the headings fall.
    const measured = await this.draw(input, null, true);
    const pages = await this.pageNumbers.locate(measured.docx, measured.headings);
    return (await this.draw(input, pages, false)).docx;
  }

  private async draw(input: HandoverDocumentInput, pages: Map<string, number> | null, placeholders: boolean): Promise<{ docx: Buffer; headings: PackHeading[] }> {
    const brand = input.brand ?? VOXSHIFT_DOCUMENT_BRAND;
    const page = PAGES[input.pageSize ?? 'a4'];
    const total = page.width - 2 * MARGIN;
    const draft = input.status.kind === 'draft';
    const author = brand.name;
    const versionLabel = input.versionLabel ?? `${input.version}`;
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
    ];
    const outline = new Outline();

    // Deployment Issues is in issued packs too: the customer sees what is still open, or that there was nothing.
    const sections = input.sections;
    let tables = 0;
    let figures = 0;
    const nextTable = () => ++tables;
    const next = { table: nextTable, figure: () => ++figures };

    // 1. Approvals & Sign-Off, and 1.1 Document Control (the template's first section, before the Introduction).
    const signed = (label: string, value: string | null) =>
      new Paragraph({ spacing: { after: 60 }, children: [text(`${label}: `), text(value || '________________________', { bold: !!value })] });
    const approval = input.approval ?? null;
    const history = input.history?.length ? input.history : [{ author: input.generatedBy, version: versionLabel, date: longDate(input.generatedAt), comments: draft ? 'Draft for review' : 'Issued' }];
    const approvals: (Paragraph | Table)[] = [
      outline.h1('Approvals & Sign-Off'),
      new Paragraph({ spacing: { after: 80 }, children: [text(approval ? 'Approved and signed off by:' : 'To be approved and signed off by:', { bold: true })] }),
      signed('Company', approval?.company ?? null),
      signed('Name', approval?.name ?? null),
      signed('Date', approval ? longDate(new Date(`${approval.date}T00:00:00Z`)) : null),
      outline.h2('Document Control'),
      dataTable(['Author/s', 'Version', 'Date', 'Comments'], history.map((h) => [h.author, h.version, h.date, h.comments]), total),
      caption(nextTable(), 'Document Control Table'),
    ];
    // the data sections follow from 2.
    // room for a picture on a page: the page less its margins, header and footer, in pixels
    const maxImageHeight = Math.round(((page.height - 2 * MARGIN) / 20) * (96 / 72)) - 100;
    const content = [...approvals, ...sections.flatMap((s, i) => sectionBody(s, total, next, i + 2, input.images ?? new Map(), maxImageHeight, outline))];

    const doc = new Document({
      creator: author,
      title: `${input.tenantName} - Service Hand-Over Pack`,
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
          { id: 'TOC1', name: 'toc 1', basedOn: 'Normal', next: 'Normal', paragraph: { spacing: { after: 100 } } },
          { id: 'TOC2', name: 'toc 2', basedOn: 'Normal', next: 'Normal', paragraph: { spacing: { after: 100 }, indent: { left: 220 } } },
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
          children: [...cover, ...contentsPage(outline, pages, placeholders, total), new Paragraph({ children: [new PageBreak()] }), ...content, new Paragraph({ spacing: { before: 480 }, alignment: AlignmentType.CENTER, children: [text('End of Document', { size: 32, color: HEADING_BLUE })] })],
        },
      ],
    });

    return { docx: await Packer.toBuffer(doc), headings: outline.headings };
  }
}
