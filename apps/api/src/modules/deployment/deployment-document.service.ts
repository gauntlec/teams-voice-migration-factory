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
import { VOXSHIFT_DOCUMENT_PALETTE, type DocumentPalette } from '@tvmf/shared';
import { docxCover, docxFooter, docxHeader } from '../branding/docx-brand';
import { VOXSHIFT_DOCUMENT_BRAND, type DocumentBrand } from '../branding/document-branding.service';

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
const WARN = 'E9A23B';
const WARN_TEXT = '8A4B00';

const OBJECT_TYPE_LABEL: Record<DeploymentPreviewRow['objectType'], string> = {
  user: 'User',
  cap: 'Common Area Phone',
  resource_account: 'Resource Account',
  call_queue: 'Call Queue',
  auto_attendant: 'Auto Attendant',
  shared_calling_policy: 'Shared Calling Policy',
};

export interface DeploymentDocumentInput {
  tenantName: string;
  siteName: string;
  sitecode: string;
  mode: 'dry_run' | 'execute';
  generatedBy: string;
  generatedAt: Date;
  rows: DeploymentPreviewRow[];
  /** whose branding the document carries (DocumentBrandingService); Voxshift's when not given */
  brand?: DocumentBrand;
}

const RESOURCE_ACCOUNT_KIND_LABEL: Record<'auto_attendant' | 'call_queue', string> = {
  auto_attendant: 'Auto Attendant',
  call_queue: 'Call Queue',
};

export interface ResourceAccountRequestItem {
  displayName: string;
  kind: 'auto_attendant' | 'call_queue';
  upn: string;
  phoneNumber: string | null;
  numberType: string | null;
  /** New-CsOnlineApplicationInstance rendered for the technical appendix - deferred, never run by Voxshift itself. */
  provisioningCommand: string;
}

export interface ResourceAccountRequestInput {
  tenantName: string;
  siteName: string;
  sitecode: string;
  generatedBy: string;
  generatedAt: Date;
  accounts: ResourceAccountRequestItem[];
  /** whose branding the document carries (DocumentBrandingService); Voxshift's when not given */
  brand?: DocumentBrand;
}

function metaRow(label: string, body: string, p: DocumentPalette = VOXSHIFT_DOCUMENT_PALETTE): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}   `, bold: true, color: p.deep, size: 20, font: UI_FONT }),
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

function rowSection(row: DeploymentPreviewRow, index: number, p: DocumentPalette): (Paragraph | Table)[] {
  return [
    new Paragraph({
      spacing: { before: 280, after: 100 },
      children: [
        new TextRun({ text: `${index + 1}. ${row.upn}`, bold: true, size: 24, color: p.brand, font: UI_FONT }),
        new TextRun({ text: `   ${OBJECT_TYPE_LABEL[row.objectType]}`, size: 18, color: MUTED, font: UI_FONT }),
      ],
    }),
    codeBlockTable(row.renderedCommands),
  ];
}

/** The users and common area phones a deployment leaves out, with why - one block, after the changes. */
function notDeployedSection(rows: DeploymentPreviewRow[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [
    new Paragraph({
      spacing: { before: 400, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: WARN, space: 4 } },
      children: [new TextRun({ text: 'Not deployed', bold: true, size: 30, color: WARN_TEXT, font: UI_FONT })],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: `${rows.length} ${rows.length === 1 ? 'user or common area phone has' : 'users and common area phones have'} a problem that stops the design being applied correctly, so the deployment leaves ${rows.length === 1 ? 'it' : 'them'} out and carries on with the rest. Fix each in Design & Build (see Validation issues), then deploy again.`,
          size: 20,
          color: INK,
          font: UI_FONT,
        }),
      ],
    }),
  ];
  rows.forEach((row) => {
    out.push(
      new Paragraph({
        spacing: { before: 200, after: 40 },
        children: [
          new TextRun({ text: row.upn, bold: true, size: 22, color: WARN_TEXT, font: UI_FONT }),
          new TextRun({ text: `   ${OBJECT_TYPE_LABEL[row.objectType]}`, size: 18, color: MUTED, font: UI_FONT }),
        ],
      }),
      ...(row.skipReasons ?? []).map(
        (reason) =>
          new Paragraph({
            spacing: { after: 30 },
            indent: { left: 240 },
            children: [new TextRun({ text: `\u2022  ${reason}`, size: 19, color: INK, font: UI_FONT })],
          }),
      ),
    );
  });
  return out;
}

function accountSection(item: ResourceAccountRequestItem, index: number, p: DocumentPalette): (Paragraph | Table)[] {
  const licenseNote =
    item.numberType === 'CallingPlan'
      ? 'Requires: Microsoft Teams Phone Resource Account license, plus a Microsoft Calling Plan license (Domestic or Domestic & International) to carry the number.'
      : 'Requires: Microsoft Teams Phone Resource Account license. The number itself is provided separately (Operator Connect/Direct Routing) - no extra calling-plan license needed for it.';
  return [
    new Paragraph({
      spacing: { before: 280, after: 60 },
      children: [
        new TextRun({ text: `${index + 1}. ${item.displayName}`, bold: true, size: 24, color: p.brand, font: UI_FONT }),
        new TextRun({ text: `   ${RESOURCE_ACCOUNT_KIND_LABEL[item.kind]}`, size: 18, color: MUTED, font: UI_FONT }),
      ],
    }),
    metaRow('UPN to create', item.upn, p),
    ...(item.phoneNumber ? [metaRow('Phone number', `${item.phoneNumber}${item.numberType ? ` (${item.numberType})` : ''}`, p)] : []),
    new Paragraph({
      spacing: { before: 60, after: 100 },
      children: [new TextRun({ text: licenseNote, size: 19, color: INK, font: UI_FONT })],
    }),
    new Paragraph({
      spacing: { before: 40, after: 40 },
      children: [new TextRun({ text: 'Technical appendix - for an admin who prefers to run this directly:', size: 17, color: MUTED, font: UI_FONT })],
    }),
    codeBlockTable([item.provisioningCommand]),
  ];
}

@Injectable()
export class DeploymentDocumentService {
  async buildResourceAccountRequest(input: ResourceAccountRequestInput): Promise<Buffer> {
    const brand = input.brand ?? VOXSHIFT_DOCUMENT_BRAND;
    const p = brand.palette;
    const header = docxHeader(brand, [new TextRun({ text: 'Resource Account Request', size: 18, color: MUTED, font: UI_FONT })]);
    const footer = docxFooter(brand, `${input.sitecode} resource account request`);

    const blankHeader = new Header({ children: [new Paragraph('')] });
    const blankFooter = new Footer({ children: [new Paragraph('')] });

    const cover: (Paragraph | Table)[] = [
      ...docxCover(brand, 'Resource Account Request'),
      metaRow('Tenant', input.tenantName, p),
      metaRow('Site', `${input.siteName} (${input.sitecode})`, p),
      metaRow('Requested by', input.generatedBy, p),
      metaRow('Requested at', input.generatedAt.toISOString(), p),
      metaRow('Accounts', String(input.accounts.length), p),
      new Paragraph({ children: [new PageBreak()] }),
    ];

    const body: (Paragraph | Table)[] = [
      calloutTable(
        'Please create and license the resource accounts below in Microsoft 365/Teams admin center (or ask your Microsoft partner to). Once each account is created and licensed, Voxshift will detect it automatically on the next sync - no need to reply confirming completion.',
        p,
      ),
      new Paragraph({ spacing: { after: 120 } }),
    ];
    if (input.accounts.length === 0) {
      body.push(
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({ text: 'No accounts to request.', size: 20, color: MUTED, font: UI_FONT })],
        }),
      );
    } else {
      input.accounts.forEach((item, i) => body.push(...accountSection(item, i, p)));
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

  async build(input: DeploymentDocumentInput): Promise<Buffer> {
    const brand = input.brand ?? VOXSHIFT_DOCUMENT_BRAND;
    const p = brand.palette;
    const header = docxHeader(brand, [new TextRun({ text: 'Change Recording', size: 18, color: MUTED, font: UI_FONT })]);
    const footer = docxFooter(brand, `${input.sitecode} change recording`);

    const blankHeader = new Header({ children: [new Paragraph('')] });
    const blankFooter = new Footer({ children: [new Paragraph('')] });

    // Users with a blocking problem are left out of the deployment; they get their own section.
    const deploying = input.rows.filter((r) => !r.skipReasons?.length);
    const notDeployed = input.rows.filter((r) => r.skipReasons?.length);
    const modeLabel = input.mode === 'dry_run' ? 'What-If' : 'Execute';
    const modeCallout =
      input.mode === 'dry_run'
        ? 'What-If mode - this document describes what would change. No commands have been sent to Microsoft Teams yet.'
        : 'Execute mode - this document describes the changes that were sent to Microsoft Teams.';

    const cover: (Paragraph | Table)[] = [
      ...docxCover(brand, 'Change Recording'),
      metaRow('Tenant', input.tenantName, p),
      metaRow('Site', `${input.siteName} (${input.sitecode})`, p),
      metaRow('Mode', modeLabel, p),
      metaRow('Generated by', input.generatedBy, p),
      metaRow('Generated at', input.generatedAt.toISOString(), p),
      metaRow('Rows', String(deploying.length), p),
      ...(notDeployed.length ? [metaRow('Not deployed', String(notDeployed.length), p)] : []),
      new Paragraph({ children: [new PageBreak()] }),
    ];

    const body: (Paragraph | Table)[] = [
      calloutTable(modeCallout, p),
      new Paragraph({ spacing: { after: 120 } }),
    ];
    if (deploying.length === 0) {
      body.push(
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({ text: 'No changes are planned for this site.', size: 20, color: MUTED, font: UI_FONT })],
        }),
      );
    } else {
      deploying.forEach((row, i) => body.push(...rowSection(row, i, p)));
    }
    if (notDeployed.length) body.push(...notDeployedSection(notDeployed));

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
