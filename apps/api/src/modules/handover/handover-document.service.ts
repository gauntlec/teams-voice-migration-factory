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
import { VOX_TILE_PNG_BASE64 } from '../deployment/assets/vox-tile';

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

export type HandoverSectionContent =
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'paragraphs'; paragraphs: string[] }
  | { kind: 'placeholder'; note: string };

export interface HandoverSectionData {
  key: string;
  title: string;
  content: HandoverSectionContent;
}

export interface HandoverDocumentInput {
  tenantName: string;
  version: number;
  generatedBy: string;
  generatedAt: Date;
  sections: HandoverSectionData[];
}

function metaRow(label: string, body: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}   `, bold: true, color: BRAND, size: 20, font: UI_FONT }),
      new TextRun({ text: body, size: 20, font: UI_FONT, color: INK }),
    ],
  });
}

function calloutTable(text: string): DocxTable {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: CALLOUT_BORDER },
      right: { style: BorderStyle.SINGLE, size: 2, color: CALLOUT_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: CALLOUT_BORDER },
      left: { style: BorderStyle.SINGLE, size: 24, color: BRAND },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: CALLOUT_BG, type: ShadingType.CLEAR, color: 'auto' },
            margins: { top: 100, bottom: 100, left: 160, right: 160 },
            children: [
              new Paragraph({
                spacing: { after: 0 },
                children: [new TextRun({ text, size: 19, color: CALLOUT_TEXT, font: UI_FONT })],
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

function dataTable(columns: string[], rows: string[][]): DocxTable {
  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map(
      (c) =>
        new TableCell({
          shading: { fill: HEADER_BG, type: ShadingType.CLEAR, color: 'auto' },
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

function sectionBody(section: HandoverSectionData): (Paragraph | Table)[] {
  const heading = new Paragraph({
    spacing: { before: 320, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TINT, space: 4 } },
    children: [new TextRun({ text: section.title, bold: true, size: 26, color: BRAND, font: UI_FONT })],
  });

  const { content } = section;
  if (content.kind === 'placeholder') {
    return [heading, calloutTable(content.note), new Paragraph({ spacing: { after: 120 } })];
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
  return [heading, dataTable(content.columns, content.rows), new Paragraph({ spacing: { after: 120 } })];
}

@Injectable()
export class HandoverDocumentService {
  async build(input: HandoverDocumentInput): Promise<Buffer> {
    const header = new Header({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GRID, space: 4 } },
          children: [
            new TextRun({ text: 'vox', bold: true, size: 20, color: INK, font: UI_FONT }),
            new TextRun({ text: 'shift', size: 20, color: ACCENT, font: UI_FONT }),
            new TextRun({ text: '\tService Handover', size: 18, color: MUTED, font: UI_FONT }),
          ],
        }),
      ],
    });

    const footer = new Footer({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: GRID, space: 4 } },
          children: [
            new TextRun({ text: `Voxshift  ·  ${input.tenantName} service handover v${input.version}`, size: 17, color: MUTED, font: UI_FONT }),
            new TextRun({ text: '\t' }),
            new TextRun({ children: [PageNumber.CURRENT], size: 17, color: MUTED, font: UI_FONT }),
          ],
        }),
      ],
    });

    const blankHeader = new Header({ children: [new Paragraph('')] });
    const blankFooter = new Footer({ children: [new Paragraph('')] });

    const cover: (Paragraph | Table)[] = [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 200 },
        children: [
          new ImageRun({
            type: 'png',
            data: Buffer.from(VOX_TILE_PNG_BASE64, 'base64'),
            transformation: { width: 68, height: 68 },
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({ text: 'vox', bold: true, size: 80, color: INK, font: UI_FONT }),
          new TextRun({ text: 'shift', size: 80, color: ACCENT, font: UI_FONT }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: TINT, space: 6 } },
        children: [new TextRun({ text: 'Service Handover', size: 34, color: BRAND, font: UI_FONT })],
      }),
      metaRow('Tenant', input.tenantName),
      metaRow('Version', `v${input.version}`),
      metaRow('Generated by', input.generatedBy),
      metaRow('Generated at', input.generatedAt.toISOString()),
      metaRow('Sections', String(input.sections.length)),
      new Paragraph({ children: [new PageBreak()] }),
    ];

    const body: (Paragraph | Table)[] = input.sections.flatMap((s) => sectionBody(s));

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
