import JSZip from 'jszip';

/*
 * A pack edited in Word and uploaded again (docs/HANDOVER-VIEW.md step 3). Voxshift keeps the person's edits: it only checks the file is a
 * Word document and moves its own markings - the version on the front page, and DRAFT when it is issued. Everything else is as uploaded.
 *
 * The markings are the ones HandoverDocumentService writes, each one run of text, which Word keeps unless that text is edited:
 * - the header: "Service Hand-Over Pack  ·  DRAFT" (bold), "Service Hand-Over Pack" once issued;
 * - the front page: "Version: 0.2 (draft)", "Version: 1.0" once issued;
 * - Document Properties: "DRAFT - not for distribution", "Issued" once issued.
 */

export const MAX_UPLOADED_PACK_BYTES = 25 * 1024 * 1024;

export class UploadedPackError extends Error {}

/** The parts of a .docx that hold text a reader sees: the body, headers and footers. */
const TEXT_PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

/** Throws UploadedPackError unless this is a Word document (.docx) without macros. */
export async function checkUploadedDocx(data: Buffer, filename: string): Promise<JSZip> {
  if (!/\.docx$/i.test(filename)) throw new UploadedPackError('Upload the pack as a Word document (.docx).');
  if (data.length > MAX_UPLOADED_PACK_BYTES) throw new UploadedPackError('The document is larger than 25 MB.');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new UploadedPackError('This file is not a Word document (.docx). Save it from Word as a .docx and upload it again.');
  }
  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (!types || !zip.file('word/document.xml')) throw new UploadedPackError('This file is not a Word document (.docx). Save it from Word as a .docx and upload it again.');
  if (/macroEnabled/i.test(types) || zip.file(/vbaProject\.bin$/i).length) throw new UploadedPackError('The document contains macros. Save it from Word as a plain .docx (not .docm) and upload it again.');
  return zip;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each `<w:t>` text equal to `from` (after its markup) replaced; `run` also edits the run's properties. Returns how many. */
function replaceText(xml: string, from: RegExp, to: (m: RegExpExecArray) => string, run?: (rPr: string) => string): { xml: string; n: number } {
  let n = 0;
  const out = xml.replace(/<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, (r) => {
    const t = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/.exec(r);
    if (!t) return r;
    const m = new RegExp(`^${from.source}$`).exec(t[2]!);
    if (!m) return r;
    n++;
    const replaced = r.replace(t[0], `${t[1]}${to(m)}${t[3]}`);
    return run ? replaced.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, run) : replaced;
  });
  return { xml: out, n };
}

async function eachTextPart(zip: JSZip, edit: (xml: string) => string) {
  for (const name of Object.keys(zip.files).filter((n) => TEXT_PARTS.test(n))) {
    const xml = await zip.file(name)!.async('string');
    const next = edit(xml);
    if (next !== xml) zip.file(name, next);
  }
}

const VERSION = /Version: ([0-9]+(?:\.[0-9]+)?)( \(draft\))?/;

/** The front page's version line set to this upload's version (it was edited from an earlier one). */
export async function relabelUploadedDraft(zip: JSZip, versionLabel: string): Promise<Buffer> {
  await eachTextPart(zip, (xml) => replaceText(xml, VERSION, () => `Version: ${versionLabel} (draft)`).xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The visible text of the body, headers and footers, for checking what is left. */
async function visibleText(zip: JSZip): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(zip.files).filter((n) => TEXT_PARTS.test(n))) {
    const xml = await zip.file(name)!.async('string');
    // a paragraph's runs joined (Word splits words across runs), paragraphs apart
    for (const p of xml.split('</w:p>')) parts.push([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
  }
  return parts.join('\n');
}

/**
 * The uploaded document as issued: Voxshift's DRAFT markings replaced and the version set. Anything else that still says DRAFT was
 * written by a person (or Word split the marking while it was edited), so `draftLeft` says so and the pack is not issued.
 */
export async function markUploadedIssued(data: Buffer, versionLabel: string): Promise<{ data: Buffer; draftLeft: boolean }> {
  const zip = await JSZip.loadAsync(data);
  await eachTextPart(zip, (xml) => {
    let out = replaceText(xml, /Service Hand-Over Pack {2}· {2}DRAFT/, () => 'Service Hand-Over Pack', (rPr) => rPr.replace(/<w:b(?:Cs)?\/>/g, '')).xml;
    out = replaceText(out, VERSION, () => `Version: ${versionLabel}`).xml;
    out = replaceText(out, new RegExp(escapeRe('DRAFT - not for distribution')), () => 'Issued').xml;
    return out;
  });
  const draftLeft = /\bDRAFT\b/.test(await visibleText(zip));
  return { data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), draftLeft };
}
