// Document branding (docs/BRANDING.md): a customer looked after by an MSP carries the MSP's branding or its own on every
// generated document, as chosen on Administration > Customers; without an MSP, its own; Voxshift's when the chosen one has none.
// Each generator - handover pack, change recording, resource account request, report PDF - draws with what the service decides.
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { forgetAppSettings, platformDb } from '@tvmf/db';
import { buildChangeLogReport, type Branding } from '@tvmf/shared';
import { DocumentBrandingService } from '../../../../apps/api/src/modules/branding/document-branding.service';
import { DeploymentDocumentService } from '../../../../apps/api/src/modules/deployment/deployment-document.service';
import { VOX_TILE_PNG_BASE64 } from '../../../../apps/api/src/modules/deployment/assets/vox-tile';
import { HandoverDocumentService } from '../../../../apps/api/src/modules/handover/handover-document.service';
import { renderReportPdf } from '../../../../apps/api/src/modules/insights/report-pdf';
import { seedCustomer, useDb, useGlobalSettingsLock, type TestCustomer } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
const db = platformDb(handle.db);
const png = Buffer.from(VOX_TILE_PNG_BASE64, 'base64');
const storage = { read: async (path: string) => (path.endsWith('.png') ? png : Promise.reject(new Error('no file'))), write: async () => undefined, delete: async () => undefined };
let svc: DocumentBrandingService;
let c: TestCustomer;
let mspId: string;

const mspBranding: Branding = { accentColor: '#D83B01', logo: { path: 'branding/msp/logo-1.png', contentType: 'image/png', version: 1, width: 68, height: 68 } };
const customerBranding: Branding = { accentColor: '#107C10', logo: null };
const setFeatures = async (disabled: string[]) => {
  await db.insertInto('app_settings').values({ id: true, email_enabled: true, base_url: null, disabled_features: disabled } as never).onConflict((oc) => oc.column('id').doUpdateSet({ disabled_features: disabled } as never)).execute();
  forgetAppSettings();
};
const docText = async (buf: Buffer) => {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const header = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/(header|footer)\d*\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')));
  return { xml: xml + header.join(''), media: Object.keys(zip.files).filter((f) => f.startsWith('word/media/')) };
};

beforeAll(async () => {
  await setFeatures([]);
  svc = new DocumentBrandingService(handle.db, storage as never);
  c = await seedCustomer(handle, { name: 'Contoso Brand' });
  mspId = (await db.insertInto('msps').values({ name: 'Fabrikam MSP', slug: `fab-${c.t.id.slice(0, 6)}`, branding: JSON.stringify(mspBranding) as never } as never).returning('id').executeTakeFirstOrThrow()).id;
});

describe('whose branding a customer’s documents carry', () => {
  it('is Voxshift’s for a customer with no branding and no MSP', async () => {
    expect(await svc.view(c.t.id)).toMatchObject({ source: 'voxshift', name: 'Voxshift', logoUrl: null, mspAvailable: false });
    expect((await svc.forDocuments(c.t.id)).source).toBe('voxshift');
  });

  it('is the customer’s own when it has branding and no MSP', async () => {
    await db.updateTable('tenants').set({ branding: JSON.stringify(customerBranding) as never }).where('id', '=', c.t.id).execute();
    const b = await svc.forDocuments(c.t.id);
    expect(b).toMatchObject({ source: 'customer', name: 'Contoso Brand', logo: null });
    expect(b.palette.brand).toBe('107C10');
  });

  it('follows the choice once an MSP looks after the customer, with the MSP’s logo', async () => {
    await db.updateTable('tenants').set({ msp_id: mspId }).where('id', '=', c.t.id).execute();
    const view = await svc.view(c.t.id);
    expect(view).toMatchObject({ source: 'msp', name: 'Fabrikam MSP', accentColor: '#D83B01', choice: 'msp', mspAvailable: true, logoUrl: `/api/public/msps/${mspId}/logo?v=1` });
    const b = await svc.forDocuments(c.t.id);
    expect(b.source).toBe('msp');
    expect(b.logo?.data.equals(png)).toBe(true);

    await db.updateTable('tenants').set({ document_branding: 'customer' }).where('id', '=', c.t.id).execute();
    expect((await svc.view(c.t.id)).source).toBe('customer');
    await db.updateTable('tenants').set({ document_branding: 'msp' }).where('id', '=', c.t.id).execute();
  });

  it('ignores the MSP while the MSP feature is switched off', async () => {
    await setFeatures(['msp']);
    try {
      expect(await svc.view(c.t.id)).toMatchObject({ source: 'customer', mspAvailable: false });
    } finally {
      await setFeatures([]);
    }
  });
});

describe('every generator draws with it', () => {
  it('brands the handover pack, change recording and resource account request: name, colour and logo', async () => {
    const brand = await svc.forDocuments(c.t.id); // the MSP's
    const docs = new DeploymentDocumentService();
    const common = { tenantName: 'Contoso Brand', siteName: 'London', sitecode: 'LON01', generatedBy: 'Eng', generatedAt: new Date('2026-11-05T09:00:00Z'), brand };
    const outputs = await Promise.all([
      new HandoverDocumentService().build({ brand, tenantName: 'Contoso Brand', version: 1, generatedBy: 'Eng', generatedAt: new Date(), scope: 'All sites', sections: [], liveAsOf: null, status: { kind: 'draft' } }),
      docs.build({ ...common, mode: 'dry_run', rows: [] }),
      docs.buildResourceAccountRequest({ ...common, accounts: [] }),
    ]);
    for (const [i, out] of outputs.entries()) {
      const { xml, media } = await docText(out);
      expect(xml).toContain('Fabrikam MSP');
      // the handover pack's colour is in its cover banner (an image), and its tables are navy for every brand
      if (i > 0) expect(xml).toContain('D83B01');
      expect(xml).not.toContain('>vox<');
      expect(media.length).toBeGreaterThan(i === 0 ? 1 : 0);
    }
    // Without a brand they look as they always have.
    const plain = await docText(await docs.build({ ...common, brand: undefined, mode: 'dry_run', rows: [] }));
    expect(plain.xml).toContain('>vox<');
    expect(plain.xml).toContain('4657D2');
  });

  it('brands a report PDF, logo and all', async () => {
    const brand = await svc.forDocuments(c.t.id);
    const pdf = await renderReportPdf(buildChangeLogReport({ from: '', to: '', rows: [], truncated: false }, { from: '2026-10-01', to: '2026-10-31' }), 'Contoso Brand', new Date(), brand);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
  });
});
