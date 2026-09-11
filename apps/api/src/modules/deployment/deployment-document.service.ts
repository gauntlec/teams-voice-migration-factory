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
import type { DeploymentPreviewRow } from '@tvmf/shared';
import { VOX_TILE_PNG_BASE64 } from './assets/vox-tile';

/**
 * Ports the Voxshift document design system established in the
 * `Voxshift-Installation-Manual.docx` generator (session scratchpad's
 * build_manual.py: BRAND/ACCENT/DEEP/TINT palette, Segoe UI/Consolas type,
 * cover + running header/footer, code-block-as-shaded-table, callout-as-
 * accent-bordered-table) to the `docx` npm package, for the API to generate
 * a branded change-recording document server-side. Same hex values as
 * apps/web/src/theme.ts and the Voxshift brand identity spec.
 */
const UI_FONT = 'Segoe UI';
const MONO = 'Consolas';
const BRAND = '4657D2';
const ACCENT = '5B5FC7';
const DEEP = '354BC0';
const INK = '242424';
const MUTED = '616161';
const TINT = 'C3C7F6';
const CODE_BG = 'F6F6FB';
const CODE_BORDER = 'DADCEC';
const CALLOUT_BG = 'EEEFFD';
const CALLOUT_TEXT = '2A2E66';
const CALLOUT_BORDER = 'D7D9EC';
const GRID = 'E3E3EC';

const OBJECT_TYPE_LABEL: Record<DeploymentPreviewRow['objectType'], string> = {
  user: 'User',
  cap: 'Common Area Phone',
  resource_account: 'Resource Account',
};

export interface DeploymentDocumentInput {
  tenantName: string;
  siteName: string;
  sitecode: string;
  mode: 'dry_run' | 'execute';
  generatedBy: string;
  generatedAt: Date;
  rows: DeploymentPreviewRow[];
}

function metaRow(label: string, body: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}   `, bold: true, color: DEEP, size: 20, font: UI_FONT }),
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

function codeBlockTable(lines: string[]): DocxTable {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: CODE_BG, type: ShadingType.CLEAR, color: 'auto' },
            margins: { top: 60, bottom: 60, left: 110, right: 90 },
            children: lines.map(
              (ln) =>
                new Paragraph({
                  spacing: { before: 0, after: 0, line: 240 },
                  children: [new TextRun({ text: ln, font: MONO, size: 17, color: '1B1B2B' })],
                }),
            ),
          }),
        ],
      }),
    ],
  });
}

function rowSection(row: DeploymentPreviewRow, index: number): (Paragraph | Table)[] {
  return [
    new Paragraph({
      spacing: { before: 280, after: 100 },
      children: [
        new TextRun({ text: `${index + 1}. ${row.upn}`, bold: true, size: 24, color: BRAND, font: UI_FONT }),
        new TextRun({ text: `   ${OBJECT_TYPE_LABEL[row.objectType]}`, size: 18, color: MUTED, font: UI_FONT }),
      ],
    }),
    codeBlockTable(row.renderedCommands),
  ];
}

@Injectable()
export class DeploymentDocumentService {
  async build(input: DeploymentDocumentInput): Promise<Buffer> {
    const header = new Header({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GRID, space: 4 } },
          children: [
            new TextRun({ text: 'vox', bold: true, size: 20, color: INK, font: UI_FONT }),
            new TextRun({ text: 'shift', size: 20, color: ACCENT, font: UI_FONT }),
            new TextRun({ text: '\tChange Recording', size: 18, color: MUTED, font: UI_FONT }),
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
            new TextRun({ text: `Voxshift  ·  ${input.sitecode} change recording`, size: 17, color: MUTED, font: UI_FONT }),
            new TextRun({ text: '\t' }),
            new TextRun({ children: [PageNumber.CURRENT], size: 17, color: MUTED, font: UI_FONT }),
          ],
        }),
      ],
    });

    const blankHeader = new Header({ children: [new Paragraph('')] });
    const blankFooter = new Footer({ children: [new Paragraph('')] });

    const modeLabel = input.mode === 'dry_run' ? 'What-If' : 'Execute';
    const modeCallout =
      input.mode === 'dry_run'
        ? 'What-If mode - this document describes what would change. No commands have been sent to Microsoft Teams yet.'
        : 'Execute mode - this document describes the changes that were sent to Microsoft Teams.';

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
        children: [new TextRun({ text: 'Change Recording', size: 34, color: BRAND, font: UI_FONT })],
      }),
      metaRow('Tenant', input.tenantName),
      metaRow('Site', `${input.siteName} (${input.sitecode})`),
      metaRow('Mode', modeLabel),
      metaRow('Generated by', input.generatedBy),
      metaRow('Generated at', input.generatedAt.toISOString()),
      metaRow('Rows', String(input.rows.length)),
      new Paragraph({ children: [new PageBreak()] }),
    ];

    const body: (Paragraph | Table)[] = [
      calloutTable(modeCallout),
      new Paragraph({ spacing: { after: 120 } }),
    ];
    if (input.rows.length === 0) {
      body.push(
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({ text: 'No changes are planned for this site.', size: 20, color: MUTED, font: UI_FONT })],
        }),
      );
    } else {
      input.rows.forEach((row, i) => body.push(...rowSection(row, i)));
    }

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
