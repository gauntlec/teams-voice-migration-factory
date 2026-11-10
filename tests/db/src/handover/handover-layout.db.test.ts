// The handover pack's layout, from the corrected AT&T pack (Hauppauge V1.18.1, 5 Nov 2026): the brand's banner and logo on the
// front page with the customer, project and site; the brand's and the customer's logos in the page header; the
// confidentiality footer; numbered headings and a table of contents; navy table headers repeated on each page with column
// widths set; numbered captions; a sentence for an empty section; Letter for US sites; Deployment Issues in drafts and issued packs.
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
  { key: 'not_yet_live', title: 'Deployment Issues', content: { kind: 'table' as const, columns: ['Item', 'Type', 'Site', 'What differs from the design'], rows: [['pat@contoso.test', 'User', 'FSD02D', 'Not found in Teams']] } },
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
    // a real contents field, already filled in, that doesn't make Word warn on opening
    expect(p.doc).toContain('TOC \\h \\o');
    expect(p.settings).not.toContain('updateFields');
    expect(p.doc).not.toContain('w:dirty');
    expect(p.doc).toMatch(/<w:pStyle w:val="TOC1"\/>.*w:anchor="_Toc1".*Approvals &amp; Sign-Off/);
    // numbered headings: Approvals & Sign-Off first, then every section heading
    expect(p.doc.match(/<w:pStyle w:val="Heading1"\/><w:numPr>/g)?.length).toBe(5);
    expect(p.doc).toContain('Approvals &amp; Sign-Off');
    expect(p.doc).toContain('Document Control Table');
    // tables: navy header row that repeats, fixed widths, numbered captions in order
    expect(p.doc).toContain('w:fill="002060"');
    expect(p.doc).toContain('<w:tblHeader/>');
    expect(p.doc).toContain('w:type="fixed"');
    expect(p.doc).toContain('Table ');
    expect(p.doc.match(/SEQ Table/g)?.length).toBe(4);
    expect(p.doc).toContain('Auto Attendants Information Table');
    // an empty section is a sentence; an issued pack keeps Deployment Issues; it ends with End of Document
    expect(p.doc).toContain('No analogue phones were deployed.');
    expect(p.doc).toContain('Deployment Issues');
    expect(p.doc).toContain('End of Document');
  });

  it('keeps Deployment Issues in a draft, marks it DRAFT, and uses A4 outside the US', async () => {
    const p = await parts(await new HandoverDocumentService().build({ ...base, pageSize: 'a4', status: { kind: 'draft' } }));
    expect(p.doc).toContain('Deployment Issues');
    expect(p.doc).toContain('DRAFT - not for distribution');
    expect(p.headers).toContain('DRAFT');
    expect(p.doc).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
  });

  it('draws the template sections: sub-headings, bullets, label tables, call queues two across, numbered actions', async () => {
    const B = (blocks: unknown[]) => ({ kind: 'blocks' as const, blocks: blocks as never });
    const p = await parts(
      await new HandoverDocumentService().build({
        ...base,
        status: { kind: 'draft' },
        sections: [
          { key: 'introduction', title: 'Introduction', content: B([{ kind: 'text', text: 'The purpose of this document…' }, { kind: 'bullets', items: ['Site Information:', '  Site name'] }]) },
          { key: 'site_information', title: 'Site Information', content: B([{ kind: 'labels', rows: [['Site Name', 'Hauppauge'], ['Site Contacts', 'a@parker.com\nb@parker.com']], caption: 'Site Information Table' }]) },
          { key: 'service_support_model', title: 'Service Support Model', content: { kind: 'paragraphs', paragraphs: ['## Welcome Document', 'The following document…', '- David Mead'] } },
          {
            key: 'call_queues',
            title: 'Call Queues',
            content: B([{ kind: 'cards', cards: [[['Name', 'Main'], ['Agents', 'x@p.com\ny@p.com']], [['Name', 'Overflow'], ['Agents', 'z@p.com']], [['Name', 'Third']]], caption: 'Call Queues Information Table' }]),
          },
          { key: 'outstanding_actions', title: 'Outstanding Actions', content: B([{ kind: 'actions', items: [{ description: 'Test 933', owner: 'AT&T' }, { description: 'Fix the diagram', owner: 'AT&T' }], caption: 'Outstanding Actions Table' }]) },
        ],
      }),
    );
    // sub-headings are numbered at the second level (Document Control, and the note's); bullets use the bullet list, two levels
    expect(p.doc.match(/<w:pStyle w:val="Heading2"\/><w:numPr><w:ilvl w:val="1"\/>/g)?.length).toBe(2);
    expect(p.doc).toContain('Welcome Document');
    expect(p.doc.match(/<w:ilvl w:val="1"\/><w:numId/g)?.length).toBeGreaterThanOrEqual(1);
    // a label value on several lines is a paragraph per line
    expect(p.doc).toContain('a@parker.com');
    expect(p.doc).toContain('b@parker.com');
    // three queues: two across, then one with an empty half
    expect(p.doc).toContain('Overflow');
    expect(p.doc).toContain('Third');
    // actions are numbered <section>.<n>: after Approvals & Sign-Off, Outstanding Actions is section 6 here
    expect(p.doc).toContain('>6.1<');
    expect(p.doc).toContain('>6.2<');
    expect(p.doc).toContain('w:fill="D9D9D9"');
    // captions run in order across every kind of table
    expect([...p.doc.matchAll(/SEQ Table[^>]*>(?:<[^>]+>)*([0-9]+)</g)].map((m) => m[1])).toEqual(['1', '2', '3', '4']);
  });

  it('gives each call flow diagram a Figure caption and puts one call queue on each row with its own caption', async () => {
    const B = (blocks: unknown[]) => ({ kind: 'blocks' as const, blocks: blocks as never });
    const p = await parts(
      await new HandoverDocumentService().build({
        ...base,
        status: { kind: 'draft' },
        images: new Map([['f1', png]]),
        sections: [
          { key: 'auto_attendants', title: 'Auto Attendants', content: B([{ kind: 'image', fileId: 'f1', title: 'Main AA', width: 68, height: 68, caption: 'Call Flow Diagram – Main AA' }]) },
          {
            key: 'call_queues',
            title: 'Call Queues',
            content: B([
              { kind: 'cards', cards: [[['Name', 'Sales'], ['Agents', 'x@p.com']]], perRow: 1, caption: 'Call Queue – Sales' },
              { kind: 'cards', cards: [[['Name', 'Support'], ['Agents', 'y@p.com']]], perRow: 1, caption: 'Call Queue – Support' },
            ]),
          },
        ],
      }),
    );
    expect(p.doc).toContain('SEQ Figure');
    expect(p.doc).toContain('Call Flow Diagram – Main AA');
    expect(p.doc).toContain('Call Queue – Sales');
    expect(p.doc).toContain('Call Queue – Support');
    // a one-across card is a two-column table (label, value), not four
    const queueTable = p.doc.slice(p.doc.indexOf('Sales') - 3000, p.doc.indexOf('Sales'));
    expect(queueTable.slice(queueTable.lastIndexOf('<w:tblGrid>')).match(/<w:gridCol /g)?.length).toBe(2);
  });
});
