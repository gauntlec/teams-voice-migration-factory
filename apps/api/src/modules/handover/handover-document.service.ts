import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopPosition,
  TabStopType,
  TextRun,
  WidthType,
  type Table as DocxTable,
} from 'docx';
import type { HandoverSectionContent } from '@tvmf/shared';
import { VOXSHIFT_DOCUMENT_PALETTE, type DocumentPalette } from '@tvmf/shared';
import { docxCover, docxFooter, docxHeader } from '../branding/docx-brand';
import { VOXSHIFT_DOCUMENT_BRAND, type DocumentBrand } from '../branding/document-branding.service';

/**
 * Reuses the Voxshift brand document design system established by
 * DeploymentDocumentService (same palette/type/cover/header/footer), with a
 * generic per-section renderer instead of a fixed content shape - Handover
 * sections are heterogeneous (some are data tables, some are narrative
 * placeholders pending a future data source).
 */
const UI_FONT = 'Segoe UI';
const BRAND = '4657D2';
const ACCENT = '5B5FC7';
const INK = '242424';
const MUTED = '616161';
const TINT = 'C3C7F6';
const CALLOUT_BG = 'EEEFFD';
const CALLOUT_TEXT = '2A2E66';
const CALLOUT_BORDER = 'D7D9EC';
const HEADER_BG = '4657D2';
const ROW_ALT_BG = 'F6F6FB';
const GRID = 'E3E3EC';

export type { HandoverSectionContent };

export interface HandoverSectionData {
  key: string;
  title: string;
  content: HandoverSectionContent;
}

export interface HandoverDocumentInput {
  /** whose branding the pack carries (DocumentBrandingService); Voxshift's when not given */
  brand?: DocumentBrand;
  tenantName: string;
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

/** "13 October 2026, 09:12 UTC" - the cover used to print a raw ISO timestamp. */
function readableDate(d: Date): string {
  return `${d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

function metaRow(label: string, body: string, p: DocumentPalette = VOXSHIFT_DOCUMENT_PALETTE): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}   `, bold: true, color: p.brand, size: 20, font: UI_FONT }),
      new TextRun({ text: body, size: 20, font: UI_FONT, color: INK }),
    ],
  });
}

function calloutTable(text: string, p: DocumentPalette = VOXSHIFT_DOCUMENT_PALETTE): DocxTable {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: p.calloutBorder },
      right: { style: BorderStyle.SINGLE, size: 2, color: p.calloutBorder },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: p.calloutBorder },
      left: { style: BorderStyle.SINGLE, size: 24, color: p.brand },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: p.calloutBg, type: ShadingType.CLEAR, color: 'auto' },
            margins: { top: 100, bottom: 100, left: 160, right: 160 },
            children: [
              new Paragraph({
                spacing: { after: 0 },
                children: [new TextRun({ text, size: 19, color: p.calloutText, font: UI_FONT })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function cellBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 2, color: GRID },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: GRID },
    left: { style: BorderStyle.SINGLE, size: 2, color: GRID },
    right: { style: BorderStyle.SINGLE, size: 2, color: GRID },
  };
}

function dataTable(columns: string[], rows: string[][], p: DocumentPalette = VOXSHIFT_DOCUMENT_PALETTE): DocxTable {
  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map(
      (c) =>
        new TableCell({
          shading: { fill: p.brand, type: ShadingType.CLEAR, color: 'auto' },
          margins: { top: 60, bottom: 60, left: 90, right: 90 },
          borders: cellBorders(),
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, size: 18, color: 'FFFFFF', font: UI_FONT })] })],
        }),
    ),
  });

  const bodyRows = rows.map(
    (row, i) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              shading: { fill: i % 2 === 1 ? ROW_ALT_BG : 'FFFFFF', type: ShadingType.CLEAR, color: 'auto' },
              margins: { top: 50, bottom: 50, left: 90, right: 90 },
              borders: cellBorders(),
              children: [new Paragraph({ children: [new TextRun({ text: cell || '—', size: 18, color: INK, font: UI_FONT })] })],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

function sectionBody(section: HandoverSectionData, p: DocumentPalette = VOXSHIFT_DOCUMENT_PALETTE): (Paragraph | Table)[] {
  const heading = new Paragraph({
    spacing: { before: 320, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: p.tint, space: 4 } },
    children: [new TextRun({ text: section.title, bold: true, size: 26, color: p.brand, font: UI_FONT })],
  });

  const { content } = section;
  if (content.kind === 'placeholder') {
    return [heading, calloutTable(content.note, p), new Paragraph({ spacing: { after: 120 } })];
  }
  if (content.kind === 'paragraphs') {
    if (content.paragraphs.length === 0) {
      return [heading, new Paragraph({ children: [new TextRun({ text: 'Nothing recorded.', size: 19, color: MUTED, font: UI_FONT })] })];
    }
    return [
      heading,
      ...content.paragraphs.map(
        (p) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: p, size: 19, color: INK, font: UI_FONT })] }),
      ),
    ];
  }
  if (content.rows.length === 0) {
    return [heading, new Paragraph({ children: [new TextRun({ text: 'Nothing recorded.', size: 19, color: MUTED, font: UI_FONT })] })];
  }
  return [heading, dataTable(content.columns, content.rows, p), new Paragraph({ spacing: { after: 120 } })];
}

@Injectable()
export class HandoverDocumentService {
  async build(input: HandoverDocumentInput): Promise<Buffer> {
    const brand = input.brand ?? VOXSHIFT_DOCUMENT_BRAND;
    const p = brand.palette;
    const draft = input.status.kind === 'draft';
    const header = docxHeader(brand, [
      new TextRun({ text: draft ? 'Service Handover  ·  DRAFT' : 'Service Handover', size: 18, color: draft ? p.brand : MUTED, bold: draft, font: UI_FONT }),
    ]);
    const footer = docxFooter(brand, `${input.tenantName} service handover v${input.version}${draft ? '  ·  DRAFT' : ''}`);

    const blankHeader = new Header({ children: [new Paragraph('')] });
    const blankFooter = new Footer({ children: [new Paragraph('')] });

    const cover: (Paragraph | Table)[] = [
      ...docxCover(brand, 'Service Handover'),
      metaRow('Tenant', input.tenantName, p),
      metaRow('Version', `v${input.version}`, p),
      metaRow('Scope', input.scope, p),
      metaRow('Generated by', input.generatedBy, p),
      metaRow('Generated at', readableDate(input.generatedAt), p),
      metaRow('Sections', String(input.sections.length), p),
      metaRow('Checked against Teams', input.liveAsOf ? readableDate(input.liveAsOf) : 'Never - run Discovery before generating', p),
      ...(input.status.kind === 'issued'
        ? [metaRow('Status', 'Issued', p), metaRow('Issued by', input.status.issuedBy, p), metaRow('Issued at', readableDate(input.status.issuedAt), p)]
        : [
            metaRow('Status', 'Draft', p),
            new Paragraph({ spacing: { after: 120 } }),
            calloutTable('DRAFT - not for distribution. This pack is still being prepared; the issued version replaces it.', p),
          ]),
      new Paragraph({ children: [new PageBreak()] }),
    ];

    const body: (Paragraph | Table)[] = input.sections.flatMap((s) => sectionBody(s, p));

    const doc = new Document({
      sections: [
        {
          properties: {
            page: { margin: { top: 1296, bottom: 1296, left: 1440, right: 1440 } },
            titlePage: true,
          },
          headers: { default: header, first: blankHeader },
          footers: { default: footer, first: blankFooter },
          children: [...cover, ...body],
        },
      ],
    });

    return Packer.toBuffer(doc);
  }
}
