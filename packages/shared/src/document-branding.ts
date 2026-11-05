/**
 * Branding on every document Voxshift generates - service handover packs, change recordings, resource account requests,
 * report PDFs (and scheduled report emails), call flow diagram PDFs. A customer looked after by an MSP (the MSP feature on
 * and an MSP chosen) carries the MSP's branding or its own, as chosen on Administration > Customers; any other customer carries
 * its own. Whichever is chosen and has no branding set falls back to Voxshift's - never silently to the other party's.
 */
import { z } from 'zod';
import { buildColorRamp, HEX_COLOR_RE } from './color';

export const DOCUMENT_BRANDING_CHOICES = ['msp', 'customer'] as const;
export type DocumentBrandingChoice = (typeof DOCUMENT_BRANDING_CHOICES)[number];
export const DOCUMENT_BRANDING_LABELS: Record<DocumentBrandingChoice, string> = { msp: 'The MSP’s branding', customer: 'The customer’s branding' };

export type DocumentBrandingSource = 'msp' | 'customer' | 'voxshift';

export const setDocumentBrandingSchema = z.object({ choice: z.enum(DOCUMENT_BRANDING_CHOICES) }).strict();
export type SetDocumentBrandingInput = z.infer<typeof setDocumentBrandingSchema>;

/** Whose branding a customer's documents carry. */
export function documentBrandingSource(i: {
  /** the MSP feature is on for this installation (Platform settings > Menus and features) */
  mspFeatureOn: boolean;
  mspId: string | null;
  choice: DocumentBrandingChoice;
  customerHasBranding: boolean;
  mspHasBranding: boolean;
}): DocumentBrandingSource {
  const mspAvailable = i.mspFeatureOn && !!i.mspId;
  if (mspAvailable && i.choice === 'msp') return i.mspHasBranding ? 'msp' : 'voxshift';
  return i.customerHasBranding ? 'customer' : 'voxshift';
}

/** GET /t/:tenantId/document-branding, and each customer on Administration > Customers. */
export interface DocumentBrandingView {
  source: DocumentBrandingSource;
  /** the name documents carry: the MSP's, the customer's or "Voxshift" */
  name: string;
  /** #RRGGBB */
  accentColor: string;
  /** the logo's public address (unauthenticated, like the email logo), or null for Voxshift's own mark */
  logoUrl: string | null;
  logoSize: { width: number; height: number } | null;
  choice: DocumentBrandingChoice;
  /** an MSP looks after this customer, so the choice applies */
  mspAvailable: boolean;
  mspName: string | null;
}

/** The colours a document uses, as 6-digit hex without '#': Voxshift's own, or built from an accent colour. */
export interface DocumentPalette {
  brand: string;
  accent: string;
  deep: string;
  tint: string;
  calloutBg: string;
  calloutText: string;
  calloutBorder: string;
}

/** Voxshift's document palette, exactly as the documents had it before branding (apps/web/src/theme.ts). */
export const VOXSHIFT_DOCUMENT_PALETTE: DocumentPalette = {
  brand: '4657D2',
  accent: '5B5FC7',
  deep: '354BC0',
  tint: 'C3C7F6',
  calloutBg: 'EEEFFD',
  calloutText: '2A2E66',
  calloutBorder: 'D7D9EC',
};

/** A palette from a brand's accent colour, on the same ramp the web theme builds (packages/shared/src/color.ts). */
export function documentPalette(accentColor: string | null | undefined): DocumentPalette {
  if (!accentColor || !HEX_COLOR_RE.test(accentColor) || accentColor.toUpperCase() === '#4657D2') return VOXSHIFT_DOCUMENT_PALETTE;
  const r = buildColorRamp(accentColor);
  const hex = (v: string) => v.replace('#', '').toUpperCase();
  return { brand: hex(accentColor), accent: hex(r[90]), deep: hex(r[70]), tint: hex(r[140]), calloutBg: hex(r[160]), calloutText: hex(r[30]), calloutBorder: hex(r[150]) };
}
