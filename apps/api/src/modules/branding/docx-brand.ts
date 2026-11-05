import { BorderStyle, Footer, Header, ImageRun, PageNumber, Paragraph, TabStopPosition, TabStopType, TextRun } from 'docx';
import { VOX_TILE_PNG_BASE64 } from '../deployment/assets/vox-tile';
import type { DocumentBrand } from './document-branding.service';

/**
 * The branded parts every Word document shares - cover mark, running header, footer - so a handover pack, a change recording
 * and a resource account request all carry the same branding (docs/BRANDING.md). Voxshift's own look is its tile and the
 * "vox"+"shift" wordmark; any other brand is its logo (when it has one) and its name, in its colour.
 */
const UI_FONT = 'Segoe UI';
const INK = '242424';
const MUTED = '616161';
const GRID = 'E3E3EC';

/** The logo scaled to fit a box, keeping its shape. */
function fit(w: number, h: number, maxW: number, maxH: number) {
  const k = Math.min(maxW / (w || maxW), maxH / (h || maxH), 1);
  return { width: Math.round((w || maxW) * k), height: Math.round((h || maxH) * k) };
}

/** The cover's mark and name, then the document's title over a tinted rule. */
export function docxCover(brand: DocumentBrand, title: string): Paragraph[] {
  const titlePara = new Paragraph({
    spacing: { after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: brand.palette.tint, space: 6 } },
    children: [new TextRun({ text: title, size: 34, color: brand.palette.brand, font: UI_FONT })],
  });
  if (brand.source === 'voxshift') {
    return [
      new Paragraph({ spacing: { after: 200 }, children: [new ImageRun({ type: 'png', data: Buffer.from(VOX_TILE_PNG_BASE64, 'base64'), transformation: { width: 68, height: 68 } })] }),
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: 'vox', bold: true, size: 80, color: INK, font: UI_FONT }), new TextRun({ text: 'shift', size: 80, color: brand.palette.accent, font: UI_FONT })],
      }),
      titlePara,
    ];
  }
  const out: Paragraph[] = [];
  if (brand.logo) {
    out.push(new Paragraph({ spacing: { after: 200 }, children: [new ImageRun({ type: brand.logo.type, data: brand.logo.data, transformation: fit(brand.logo.width, brand.logo.height, 260, 90) })] }));
  }
  out.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: brand.name, bold: true, size: brand.logo ? 48 : 64, color: INK, font: UI_FONT })] }), titlePara);
  return out;
}

/** The running header: the brand on the left, the document's name (and anything extra) on the right. */
export function docxHeader(brand: DocumentBrand, right: TextRun[]): Header {
  const left =
    brand.source === 'voxshift'
      ? [new TextRun({ text: 'vox', bold: true, size: 20, color: INK, font: UI_FONT }), new TextRun({ text: 'shift', size: 20, color: brand.palette.accent, font: UI_FONT })]
      : [new TextRun({ text: brand.name, bold: true, size: 20, color: brand.palette.brand, font: UI_FONT })];
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GRID, space: 4 } },
        children: [...left, new TextRun({ text: '\t' }), ...right],
      }),
    ],
  });
}

/** The footer: the brand's name and what the document is, and the page number. */
export function docxFooter(brand: DocumentBrand, text: string): Footer {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: GRID, space: 4 } },
        children: [
          new TextRun({ text: `${brand.name}  ·  ${text}`, size: 17, color: MUTED, font: UI_FONT }),
          new TextRun({ text: '\t' }),
          new TextRun({ children: [PageNumber.CURRENT], size: 17, color: MUTED, font: UI_FONT }),
        ],
      }),
    ],
  });
}
