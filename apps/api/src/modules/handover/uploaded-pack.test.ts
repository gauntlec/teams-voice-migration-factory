import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { checkUploadedDocx, markUploadedIssued, relabelUploadedDraft, UploadedPackError } from './uploaded-pack';

const run = (text: string, bold = false) => `<w:r><w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;

async function docx(body: string, header = para(run('Service Hand-Over Pack  ·  DRAFT', true)), types = '<Types><Default Extension="xml" ContentType="application/xml"/></Types>') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', types);
  zip.file('word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`);
  zip.file('word/header1.xml', `<w:hdr>${header}</w:hdr>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const textOf = async (buf: Buffer, part: string) => [...(await (await JSZip.loadAsync(buf)).file(part)!.async('string')).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);

const DRAFT_BODY = para(run('Version: 0.2 (draft)')) + para(run('Document Status'), run('DRAFT - not for distribution')) + para(run('Added in Word by hand.'));

describe('an uploaded pack', () => {
  it('must be a .docx Word document without macros', async () => {
    const good = await docx(DRAFT_BODY);
    await expect(checkUploadedDocx(good, 'pack.docx')).resolves.toBeInstanceOf(JSZip);
    await expect(checkUploadedDocx(good, 'pack.pdf')).rejects.toBeInstanceOf(UploadedPackError);
    await expect(checkUploadedDocx(Buffer.from('not a zip'), 'pack.docx')).rejects.toThrow(/not a Word document/);
    const macros = await docx(DRAFT_BODY, undefined, '<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>');
    await expect(checkUploadedDocx(macros, 'pack.docx')).rejects.toThrow(/macros/);
  });

  it('takes this upload’s version on the front page, and is issued with Voxshift’s DRAFT markings gone and the edits kept', async () => {
    const relabelled = await relabelUploadedDraft(await checkUploadedDocx(await docx(DRAFT_BODY), 'p.docx'), '0.3');
    expect(await textOf(relabelled, 'word/document.xml')).toContain('Version: 0.3 (draft)');

    const { data, draftLeft } = await markUploadedIssued(relabelled, '1.0');
    expect(draftLeft).toBe(false);
    expect(await textOf(data, 'word/document.xml')).toEqual(['Version: 1.0', 'Document Status', 'Issued', 'Added in Word by hand.']);
    expect(await textOf(data, 'word/header1.xml')).toEqual(['Service Hand-Over Pack']);
    // the header is no longer bold once it no longer says DRAFT
    expect(await (await JSZip.loadAsync(data)).file('word/header1.xml')!.async('string')).not.toContain('<w:b/>');
  });

  it('says so when something else still says DRAFT, such as a marking Word split while it was edited', async () => {
    const split = para(run('Version: 0.2 (draft)')) + para(run('DRAFT - not '), run('for distribution'));
    expect((await markUploadedIssued(await docx(split), '1.0')).draftLeft).toBe(true);
  });
});
