import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { disabledFeatures, platformDb } from '@tvmf/db';
import {
  documentBrandingSource,
  documentPalette,
  VOXSHIFT_DOCUMENT_PALETTE,
  type Branding,
  type DocumentBrandingChoice,
  type DocumentBrandingSource,
  type DocumentBrandingView,
  type DocumentPalette,
} from '@tvmf/shared';
import { InjectDb, type Db } from '../../db/db.module';
import { FILE_STORAGE_BACKEND, type FileStorageBackend } from '../files/file-storage.interface';

/** What a document generator draws with: whose name, which colours, which logo (null = Voxshift's own mark and wordmark). */
export interface DocumentBrand {
  source: DocumentBrandingSource;
  name: string;
  palette: DocumentPalette;
  logo: { data: Buffer; type: 'png' | 'jpg'; width: number; height: number } | null;
}

export const VOXSHIFT_DOCUMENT_BRAND: DocumentBrand = { source: 'voxshift', name: 'Voxshift', palette: VOXSHIFT_DOCUMENT_PALETTE, logo: null };

/**
 * The one place that decides a customer's document branding (packages/shared/src/document-branding.ts), for every generator:
 * handover packs, change recordings, resource account requests, report PDFs and the call flow diagram PDF (through
 * GET /t/:tenantId/document-branding).
 */
@Injectable()
export class DocumentBrandingService {
  private readonly log = new Logger('DocumentBranding');

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(FILE_STORAGE_BACKEND) private readonly storage: FileStorageBackend,
  ) {}

  private async load(tenantId: string) {
    const t = await platformDb(this.db)
      .selectFrom('tenants as t')
      .leftJoin('msps as m', 'm.id', 't.msp_id')
      .select(['t.id as id', 't.name as name', 't.branding as branding', 't.msp_id as mspId', 't.document_branding as choice', 'm.name as mspName', 'm.branding as mspBranding'])
      .where('t.id', '=', tenantId)
      .executeTakeFirst();
    if (!t) throw new NotFoundException('Customer not found.');
    const mspFeatureOn = !(await disabledFeatures(this.db)).includes('msp');
    const customerBranding = t.branding as Branding | null;
    const mspBranding = t.mspBranding as Branding | null;
    const source = documentBrandingSource({
      mspFeatureOn,
      mspId: t.mspId,
      choice: t.choice as DocumentBrandingChoice,
      customerHasBranding: !!customerBranding,
      mspHasBranding: !!mspBranding,
    });
    const branding = source === 'msp' ? mspBranding : source === 'customer' ? customerBranding : null;
    const ownerId = source === 'msp' ? t.mspId : t.id;
    return { t, mspFeatureOn, source, branding, ownerId };
  }

  async view(tenantId: string): Promise<DocumentBrandingView> {
    const { t, mspFeatureOn, source, branding, ownerId } = await this.load(tenantId);
    const logo = branding?.logo ?? null;
    return {
      source,
      name: source === 'msp' ? (t.mspName ?? 'Voxshift') : source === 'customer' ? t.name : 'Voxshift',
      accentColor: branding?.accentColor ?? '#4657D2',
      logoUrl: logo ? `/api/public/${source === 'msp' ? 'msps' : 'tenants'}/${ownerId}/logo?v=${logo.version}` : null,
      logoSize: logo ? { width: logo.width, height: logo.height } : null,
      choice: t.choice as DocumentBrandingChoice,
      mspAvailable: mspFeatureOn && !!t.mspId,
      mspName: t.mspName,
    };
  }

  /** The brand a document for this customer is drawn with. A logo that can't be read is left out, never failing the document. */
  async forDocuments(tenantId: string): Promise<DocumentBrand> {
    const { t, source, branding } = await this.load(tenantId);
    if (source === 'voxshift' || !branding) return VOXSHIFT_DOCUMENT_BRAND;
    let logo: DocumentBrand['logo'] = null;
    if (branding.logo) {
      try {
        logo = {
          data: await this.storage.read(branding.logo.path),
          type: branding.logo.contentType === 'image/png' ? 'png' : 'jpg',
          width: branding.logo.width,
          height: branding.logo.height,
        };
      } catch (e) {
        this.log.warn(`logo for ${tenantId} could not be read: ${(e as Error).message}`);
      }
    }
    return { source, name: source === 'msp' ? (t.mspName ?? t.name) : t.name, palette: documentPalette(branding.accentColor), logo };
  }
}
