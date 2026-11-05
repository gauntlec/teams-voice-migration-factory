// The handover pack's layout, from the corrected AT&T pack (Hauppauge V1.18.1, 5 Nov 2026): the brand's banner and logo on the
// front page with the customer, project and site; the brand's and the customer's logos in the page header; the
// confidentiality footer; numbered headings and a table of contents; navy table headers repeated on each page with column
// widths set; numbered captions; a sentence for an empty section; Letter for US sites; the not-yet-live checklist in drafts only.
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { documentPalette } from '@tvmf/shared';
import { VOX_TILE_PNG_BASE64 } from '../../../../apps/api/src/modules/deployment/assets/vox-tile';
import { HandoverDocumentService } from '../../../../apps/api/src/modules/handover/handover-document.service';

const png = Buffer.from(VOX_TILE_PNG_BASE64, 'base64');
const logo = { data: png, type: 'png' as const, width: 68, height: 68 };
const brand = { source: 'msp' as const, name: 'AT&T Consulting', palette: documentPalette('#009FDB'), logo };
const sections = [
  { key: 'phone_numbers', title: 'Phone Numbers', content: { kind: 'table' as const, columns: ['Number', 'Status', 'Assigned to (in Teams)', 'Site', 'Carrier'], rows: [['16312313737', 'In use', 'Hauppauge Main Number', 'FSD02D', 'AT&T Cloud Voice']] } },
  { key: 'analogue_phones', title: 'Analogue (SIP) Phones', content: { kind: 'table' as const, columns: ['Number', 'Site', 'Note'], rows: [] } },
  { key: 'auto_attendants', title: 'Auto Attendants', content: { kind: 'table' as const, columns: ['Name', 'Site', 'Language', 'Time zone', 'Resource accounts'], rows: [['AA-US-FSD02D-MainNumber', 'FSD02D', 'en-US', 'Eastern Standard Time', '2']] } },
  { key: 'not_yet_live', title: 'Designed but Not Yet Live', content: { kind: 'table' as const, columns: ['Item', 'Type', 'Site', 'What differs from the design'], rows: [['pat@contoso.test', 'User', 'FSD02D', 'Not found in Teams']] } },
];
const base = { brand, customerLogo: logo, tenantName: 'Parker Hannifin', projectName: 'AT&T Global Teams Project', siteLabel: 'Hauppauge', version: 3, generatedBy: 'Mark Fowles', generatedAt: new Date('2026-11-05T10:00:00Z'), scope: 'FSD02D', sections, liveAsOf: new Date('2026-11-05T09:00:00Z') };
const parts = async (buf: Buffer) => {
  const zip = await JSZip.loadAsync(buf);
  const read = (f: string) => zip.file(f)!.async('string');
  const headers = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/header\d*\.xml$/.test(f)).map(read));
  const footers = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/footer\d*\.xml$/.test(f)).map(read));
  return { doc: await read('word/document.xml'), styles: await read('word/styles.xml'), settings: await read('word/settings.xml'), headers: headers.join(''), footers: footers.join(''), media: Object.keys(zip.files).filter((f) => f.startsWith('word/media/')) };
};

describe('the handover pack layout', () => {
  it('draws the front page, header, footer, contents, numbered headings and navy tables of the template', async () => {
    const p = await parts(await new HandoverDocumentService().build({ ...base, pageSize: 'letter', status: { kind: 'issued', issuedBy: 'Mark Fowles', issuedAt: new Date('2026-11-05T12:00:00Z') } }));
    // front page: customer, project, site, and the document details
    for (const t of ['Parker Hannifin', 'AT&amp;T Global Teams Project', 'Site: Hauppauge', 'Document Author', 'AT&amp;T Consulting', 'Version 3']) expect(p.doc).toContain(t);
    // banner + brand logo + customer logo (the header reuses the images)
    expect(p.media.length).toBeGreaterThanOrEqual(3);
    // US Letter, 1-inch margins
    expect(p.doc).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
    // header: brand and title; footer: the notice, page x of y, version, copyright
    expect(p.headers).toContain('Service Hand-Over Pack');
    for (const t of ['CONFIDENTIAL INFORMATION', 'PAGE', 'NUMPAGES', 'Version: 3', '© 2026 AT&amp;T Consulting. All rights reserved.']) expect(p.footers).toContain(t);
    // Calibri text, Calibri Light blue headings, a table of contents that Word fills in on opening
    expect(p.styles).toContain('w:ascii="Calibri"');
    expect(p.styles).toContain('Calibri Light');
    expect(p.styles).toContain('2F5496');
    expect(p.doc).toContain('TOC \\h \\o');
    expect(p.settings).toContain('updateFields');
    // numbered headings: every section heading carries the heading numbering
    expect(p.doc.match(/<w:pStyle w:val="Heading1"\/><w:numPr>/g)?.length).toBe(3);
    // tables: navy header row that repeats, fixed widths, numbered captions in order
    expect(p.doc).toContain('w:fill="002060"');
    expect(p.doc).toContain('<w:tblHeader/>');
    expect(p.doc).toContain('w:type="fixed"');
    expect(p.doc).toContain('Table ');
    expect(p.doc.match(/SEQ Table/g)?.length).toBe(2);
    expect(p.doc).toContain('Auto Attendants Information Table');
    // an empty section is a sentence; an issued pack leaves out the not-yet-live checklist; it ends with End of Document
    expect(p.doc).toContain('No analogue phones were deployed.');
    expect(p.doc).not.toContain('Designed but Not Yet Live');
    expect(p.doc).toContain('End of Document');
  });

  it('keeps the not-yet-live checklist in a draft, marks it DRAFT, and uses A4 outside the US', async () => {
    const p = await parts(await new HandoverDocumentService().build({ ...base, pageSize: 'a4', status: { kind: 'draft' } }));
    expect(p.doc).toContain('Designed but Not Yet Live');
    expect(p.doc).toContain('DRAFT - not for distribution');
    expect(p.headers).toContain('DRAFT');
    expect(p.doc).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
  });
});
