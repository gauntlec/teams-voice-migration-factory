import JSZip from 'jszip';
import PDFDocument from 'pdfkit';

/**
 * A PDF placed inside a Word document as an icon the reader double-clicks to open (feature request "Service Handover Pack", item 4:
 * each call flow diagram as an embedded PDF). The `docx` library can't write embedded objects, so the pack is drawn with a marker
 * paragraph where each one goes and `embedPdfs` swaps the marker for the object afterwards.
 *
 * The object is laid out exactly as "Embed test B - Word package.docx", which the reviewer opened in Word on Windows (5 Nov 2026):
 * - word/embeddings/oleObjectN.bin: an OLE compound file holding a Windows "Package" (ProgID Package) that carries the PDF. A Package
 *   needs nothing installed to embed it; double-clicking opens the PDF in whatever opens PDFs.
 * - word/media/vxs-pdf-icon.png: the icon Word shows (the same one for every object).
 * - in word/document.xml, a w:object whose VML shape shows the icon and whose o:OLEObject (DrawAspect="Icon") names the .bin.
 * - word/_rels/document.xml.rels: an image and an oleObject relationship; [Content_Types].xml: the .bin type.
 */

/** The icon: a page with a red "PDF" band, 120 × 150 pixels, shown at 60 × 75 points. */
const PDF_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAACWCAIAAACaSNt3AAACEElEQVR4nO3W0W0iURQEUUfiOCvEzcqWWgTADBSM2Tq6n6h51Bdf5CW+3v2A/8Ut9E80TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1TKF1zC30v+/vTrpCF/qzrtCF/qwrdKE/6x4K/eBfy6csX+fNhS50od/+aO+Xe28udKEL/fZHe7/ce/OrQz/4yessP/cKXeh3Lxe60IUudKGvu3z10Pe7TuijI4U+uXx0pNAnl4+OFPrk8tGRQp9cPjpS6JPLR0cKfXL56MglQj/lWS8O/dymhS50oQtd6EIXutCFvmv5KV9X6EIXutCFLnShC13ortB/5wpd6M+6Qhf6s67Q7wh9/7/XHMUUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWscUWsfcQsdW6Bf5Bf1mWafoQXMBAAAAAElFTkSuQmCC';

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* The OLE compound file (MS-CFB, version 3: 512-byte sectors, 64-byte mini sectors for streams under 4096 bytes).                 */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const SECTOR = 512;
const MINI = 64;
const MINI_CUTOFF = 4096;
const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const NO_STREAM = 0xffffffff;

export interface CompoundStream {
  name: string;
  data: Buffer;
}

/** The order MS-CFB keeps siblings in: shorter names first, then by upper-cased name. */
function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A GUID as the 16 bytes a compound file stores (the first three groups little-endian). */
export function guidBytes(guid: string): Buffer {
  const h = guid.replace(/[{}-]/g, '');
  const b = Buffer.from(h, 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8, 16)]);
}

/**
 * A compound file with one storage (the root, with `rootClsid`) holding `streams`. Small streams go in the mini stream as the format
 * requires; the siblings hang off the root as one chain in name order, as in the tested document.
 */
export function compoundFile(streams: CompoundStream[], rootClsid: string): Buffer {
  const sorted = [...streams].sort((a, b) => compareNames(a.name, b.name));
  const small = sorted.filter((s) => s.data.length < MINI_CUTOFF);
  const large = sorted.filter((s) => s.data.length >= MINI_CUTOFF);

  // the mini stream: each small stream padded to whole mini sectors, and its chain in the mini FAT
  const miniStart = new Map<CompoundStream, number>();
  const miniFat: number[] = [];
  for (const s of small) {
    const n = Math.ceil(s.data.length / MINI);
    if (n === 0) continue;
    miniStart.set(s, miniFat.length);
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? END_OF_CHAIN : miniFat.length + 1);
  }
  const miniStreamBytes = miniFat.length * MINI;

  const sectorsFor = (bytes: number) => Math.ceil(bytes / SECTOR);
  const miniFatSectors = sectorsFor(miniFat.length * 4);
  const dirSectors = sectorsFor((sorted.length + 1) * 128);
  const miniStreamSectors = sectorsFor(miniStreamBytes);
  const largeSectors = large.reduce((n, s) => n + sectorsFor(s.data.length), 0);
  const dataSectors = miniFatSectors + dirSectors + miniStreamSectors + largeSectors;

  // FAT sectors (128 entries each) must cover every sector, themselves and any DIFAT sectors included; the header lists 109 of them
  let fatSectors = 1;
  let difatSectors = 0;
  for (;;) {
    difatSectors = fatSectors > 109 ? Math.ceil((fatSectors - 109) / 127) : 0;
    if (fatSectors * 128 >= dataSectors + fatSectors + difatSectors) break;
    fatSectors++;
  }

  // layout: FAT, DIFAT, mini FAT, directory, mini stream, then each large stream
  let next = 0;
  const fatAt = next;
  next += fatSectors;
  const difatAt = next;
  next += difatSectors;
  const miniFatAt = next;
  next += miniFatSectors;
  const dirAt = next;
  next += dirSectors;
  const miniStreamAt = next;
  next += miniStreamSectors;
  const largeAt = new Map<CompoundStream, number>();
  for (const s of large) {
    largeAt.set(s, next);
    next += sectorsFor(s.data.length);
  }
  const totalSectors = next;

  const fat = new Array<number>(fatSectors * 128).fill(FREE);
  for (let i = 0; i < fatSectors; i++) fat[fatAt + i] = FAT_SECTOR;
  for (let i = 0; i < difatSectors; i++) fat[difatAt + i] = DIFAT_SECTOR;
  const chain = (start: number, count: number) => {
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END_OF_CHAIN : start + i + 1;
  };
  chain(miniFatAt, miniFatSectors);
  chain(dirAt, dirSectors);
  chain(miniStreamAt, miniStreamSectors);
  for (const s of large) chain(largeAt.get(s)!, sectorsFor(s.data.length));

  const out = Buffer.alloc(SECTOR * (1 + totalSectors));
  const at = (sector: number) => SECTOR * (1 + sector);

  // header
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(out, 0);
  out.writeUInt16LE(0x003e, 24); // minor version
  out.writeUInt16LE(0x0003, 26); // major version 3
  out.writeUInt16LE(0xfffe, 28); // little-endian
  out.writeUInt16LE(9, 30); // 512-byte sectors
  out.writeUInt16LE(6, 32); // 64-byte mini sectors
  out.writeUInt32LE(0, 40); // directory sectors (always 0 in version 3)
  out.writeUInt32LE(fatSectors, 44);
  out.writeUInt32LE(dirAt, 48);
  out.writeUInt32LE(0, 52); // transaction signature
  out.writeUInt32LE(MINI_CUTOFF, 56);
  out.writeUInt32LE(miniFatSectors ? miniFatAt : END_OF_CHAIN, 60);
  out.writeUInt32LE(miniFatSectors, 64);
  out.writeUInt32LE(difatSectors ? difatAt : END_OF_CHAIN, 68);
  out.writeUInt32LE(difatSectors, 72);
  for (let i = 0; i < 109; i++) out.writeUInt32LE(i < fatSectors ? fatAt + i : FREE, 76 + i * 4);

  // DIFAT sectors: the FAT sectors past the first 109, 127 to a sector, each ending with the next DIFAT sector
  for (let d = 0; d < difatSectors; d++) {
    const base = at(difatAt + d);
    for (let i = 0; i < 127; i++) {
      const f = 109 + d * 127 + i;
      out.writeUInt32LE(f < fatSectors ? fatAt + f : FREE, base + i * 4);
    }
    out.writeUInt32LE(d === difatSectors - 1 ? END_OF_CHAIN : difatAt + d + 1, base + 127 * 4);
  }

  // FAT
  fat.forEach((v, i) => out.writeUInt32LE(v, at(fatAt) + i * 4));

  // mini FAT (the rest of its last sector is free)
  for (let i = 0; i < miniFatSectors * (SECTOR / 4); i++) out.writeUInt32LE(i < miniFat.length ? miniFat[i]! : FREE, at(miniFatAt) + i * 4);

  // directory: the root, then the streams in name order, each the right sibling of the one before
  const entry = (i: number, e: { name: string; type: 1 | 2 | 5; right: number; child: number; clsid?: Buffer; start: number; size: number }) => {
    const base = at(dirAt) + i * 128;
    const name = Buffer.from(`${e.name}\0`, 'utf16le');
    name.copy(out, base);
    out.writeUInt16LE(name.length, base + 64);
    out.writeUInt8(e.type, base + 66);
    out.writeUInt8(1, base + 67); // black
    out.writeUInt32LE(NO_STREAM, base + 68); // left sibling
    out.writeUInt32LE(e.right, base + 72);
    out.writeUInt32LE(e.child, base + 76);
    e.clsid?.copy(out, base + 80);
    out.writeUInt32LE(e.start, base + 116);
    out.writeUInt32LE(e.size, base + 120);
  };
  entry(0, { name: 'Root Entry', type: 5, right: NO_STREAM, child: sorted.length ? 1 : NO_STREAM, clsid: guidBytes(rootClsid), start: miniStreamSectors ? miniStreamAt : END_OF_CHAIN, size: miniStreamBytes });
  sorted.forEach((s, i) => {
    const start = s.data.length >= MINI_CUTOFF ? largeAt.get(s)! : (miniStart.get(s) ?? END_OF_CHAIN);
    entry(i + 1, { name: s.name, type: 2, right: i + 1 < sorted.length ? i + 2 : NO_STREAM, child: NO_STREAM, start, size: s.data.length });
  });
  // unused entries in the last directory sector
  for (let i = sorted.length + 1; i < dirSectors * 4; i++) {
    const base = at(dirAt) + i * 128;
    out.writeUInt32LE(NO_STREAM, base + 68);
    out.writeUInt32LE(NO_STREAM, base + 72);
    out.writeUInt32LE(NO_STREAM, base + 76);
  }

  // the stream data
  for (const s of small) if (miniStart.has(s)) s.data.copy(out, at(miniStreamAt) + miniStart.get(s)! * MINI);
  for (const s of large) s.data.copy(out, at(largeAt.get(s)!));
  return out;
}

/**
 * The streams of a compound file, by name, and the root's CLSID: what compoundFile writes, read back (the tests use it to open what a
 * pack embeds). Throws on anything that isn't a well-formed compound file.
 */
export function readCompoundFile(buf: Buffer): { rootClsid: Buffer; streams: Map<string, Buffer> } {
  if (buf.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw new Error('not a compound file');
  const size = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const cutoff = buf.readUInt32LE(56);
  const sector = (n: number) => buf.subarray(size * (n + 1), size * (n + 2));
  // the FAT's sectors: 109 in the header, the rest in the DIFAT chain
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) fatSectors.push(buf.readUInt32LE(76 + i * 4));
  for (let d = buf.readUInt32LE(68), guard = 0; d !== END_OF_CHAIN && d !== FREE && guard < 1e6; guard++) {
    const s = sector(d);
    for (let i = 0; i < size / 4 - 1; i++) fatSectors.push(s.readUInt32LE(i * 4));
    d = s.readUInt32LE(size - 4);
  }
  const fat: number[] = [];
  for (const f of fatSectors.slice(0, buf.readUInt32LE(44))) for (let i = 0; i < size / 4; i++) fat.push(sector(f).readUInt32LE(i * 4));
  const follow = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let s = start; s !== END_OF_CHAIN; s = table[s]!) {
      if (s === undefined || s >= table.length || out.length > table.length) throw new Error('broken sector chain');
      out.push(s);
    }
    return out;
  };
  const read = (start: number) => Buffer.concat(follow(start, fat).map(sector));
  const dir = read(buf.readUInt32LE(48));
  const miniFat: number[] = [];
  if (buf.readUInt32LE(64) > 0) {
    const m = read(buf.readUInt32LE(60));
    for (let i = 0; i < m.length / 4; i++) miniFat.push(m.readUInt32LE(i * 4));
  }
  const miniStream = read(dir.readUInt32LE(116));
  const streams = new Map<string, Buffer>();
  for (let i = 1; i < dir.length / 128; i++) {
    const e = dir.subarray(i * 128, (i + 1) * 128);
    if (e.readUInt8(66) !== 2) continue;
    const name = e.subarray(0, Math.max(0, e.readUInt16LE(64) - 2)).toString('utf16le');
    const length = e.readUInt32LE(120);
    const start = e.readUInt32LE(116);
    const data = length < cutoff ? Buffer.concat(follow(start, miniFat).map((m) => miniStream.subarray(m * miniSize, (m + 1) * miniSize))) : read(start);
    streams.set(name, data.subarray(0, length));
  }
  return { rootClsid: Buffer.from(dir.subarray(80, 96)), streams };
}

/** The file a Package's \1Ole10Native stream carries, and the name it carries it under. */
export function readPackage(ole10Native: Buffer): { fileName: string; data: Buffer } {
  let at = 6;
  const z = () => {
    const end = ole10Native.indexOf(0, at);
    const s = ole10Native.subarray(at, end).toString('latin1');
    at = end + 1;
    return s;
  };
  const fileName = z();
  z(); // source path
  at += 4; // reserved, type 3
  at += 4 + ole10Native.readUInt32LE(at); // temporary path
  const length = ole10Native.readUInt32LE(at);
  return { fileName, data: ole10Native.subarray(at + 4, at + 4 + length) };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* The Package object (as Windows' Object Packager writes it): \1Ole10Native carries the file, \1CompObj says what the object is.  */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const PACKAGE_CLSID = '0003000C-0000-0000-C000-000000000046';

/** \1CompObj for a Package: "OLE Package", clipboard format none, ProgID "Package" - byte for byte as in the tested document. */
const PACKAGE_COMPOBJ = Buffer.from(
  '0100feff030a0000ffffffff' + // header
    '0c00030000000000c000000000000046' + // the Package CLSID
    '0c0000004f4c45205061636b61676500' + // "OLE Package"
    '00000000' + // no clipboard format
    '080000005061636b61676500' + // "Package"
    'f439b271' + // Unicode marker
    '000000000000000000000000',
  'hex',
);
/** \3ObjInfo and \1Sh33tJ5, as in the tested document. */
const PACKAGE_OBJINFO = Buffer.from('000003000d00', 'hex');
const PACKAGE_SH33TJ5 = Buffer.from('7262', 'ascii');

/** A file name Windows will take and the Packager's ANSI strings can hold: plain ASCII, no characters Windows refuses, at most 120 long. */
export function packageFileName(name: string, extension = '.pdf'): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 120 - extension.length) || 'Attachment';
  return `${base}${extension}`;
}

/** \1Ole10Native: the size of the rest, then the label, the source path, the temporary path and the file's bytes. */
function ole10Native(fileName: string, data: Buffer): Buffer {
  const z = (s: string) => Buffer.from(`${s}\0`, 'latin1');
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const path = `C:\\Temp\\${fileName}`;
  const rest = Buffer.concat([u16(2), z(fileName), z(path), u16(0), u16(3), u32(path.length + 1), z(path), u32(data.length), data]);
  return Buffer.concat([u32(rest.length), rest]);
}

/** The oleObjectN.bin for a file: a Package carrying it under `fileName`. */
export function packageObject(fileName: string, data: Buffer): Buffer {
  return compoundFile(
    [
      { name: '\u0001CompObj', data: PACKAGE_COMPOBJ },
      { name: '\u0001Ole10Native', data: ole10Native(fileName, data) },
      { name: '\u0001Sh33tJ5', data: PACKAGE_SH33TJ5 },
      { name: '\u0003ObjInfo', data: PACKAGE_OBJINFO },
    ],
    PACKAGE_CLSID,
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Putting the objects into the .docx                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export interface PdfEmbed {
  /** what the reader sees when it opens, e.g. "Call Flow Diagram - Main Line.pdf" (made safe with packageFileName) */
  fileName: string;
  pdf: Buffer;
}

/** The text a marker paragraph carries until embedPdfs replaces its run with the object. */
export const embedMarker = (n: number) => `__VXS_EMBED_${n}__`;

const ICON_REL = 'rIdVxsPdfIcon';
const ICON_PART = 'media/vxs-pdf-icon.png';
const OLE_TYPE = 'application/vnd.openxmlformats-officedocument.oleObject';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_OLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject';

/** The run that shows the icon (60 × 75 pt) and holds object n - the tested document's run, with its own ids. */
function objectRun(n: number): string {
  const shape = `_x0000_i${2000 + n}`;
  return (
    `<w:r><w:object w:dxaOrig="1200" w:dyaOrig="1500">` +
    `<v:shape id="${shape}" type="#_x0000_t75" style="width:60pt;height:75pt" o:ole=""><v:imagedata r:id="${ICON_REL}" o:title=""/></v:shape>` +
    `<o:OLEObject Type="Embed" ProgID="Package" ShapeID="${shape}" DrawAspect="Icon" ObjectID="_${1854787730 + n}" r:id="rIdVxsOle${n}"/>` +
    `</w:object></w:r>`
  );
}

/**
 * The .docx with embeds[n] in place of the run holding embedMarker(n): the object parts, their relationships and the .bin content type
 * added. A marker whose embed is missing loses its run (an empty paragraph stays); the document never fails for want of an object.
 */
export async function embedPdfs(docx: Buffer, embeds: readonly PdfEmbed[]): Promise<Buffer> {
  if (embeds.length === 0) return docx;
  const zip = await JSZip.loadAsync(docx);
  const docPart = zip.file('word/document.xml');
  const relsPart = zip.file('word/_rels/document.xml.rels');
  const typesPart = zip.file('[Content_Types].xml');
  if (!docPart || !relsPart || !typesPart) return docx;

  let xml = await docPart.async('string');
  // the VML and Office namespaces the object needs, if the root doesn't declare them already
  const root = /<w:document\b[^>]*>/.exec(xml)?.[0] ?? '';
  const add = [
    !/\sxmlns:v=/.test(root) ? ' xmlns:v="urn:schemas-microsoft-com:vml"' : '',
    !/\sxmlns:o=/.test(root) ? ' xmlns:o="urn:schemas-microsoft-com:office:office"' : '',
  ].join('');
  if (add) xml = xml.replace(root, root.replace(/>$/, `${add}>`));

  const used: number[] = [];
  xml = xml.replace(/<w:r>(?:(?!<\/w:r>)[\s\S])*?__VXS_EMBED_(\d+)__(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, (_, i: string) => {
    const n = Number(i);
    if (!embeds[n]) return '';
    used.push(n);
    return objectRun(n + 1);
  });
  if (used.length === 0) return docx;
  zip.file('word/document.xml', xml);

  let rels = await relsPart.async('string');
  const newRels = [`<Relationship Id="${ICON_REL}" Type="${REL_IMAGE}" Target="${ICON_PART}"/>`, ...used.map((n) => `<Relationship Id="rIdVxsOle${n + 1}" Type="${REL_OLE}" Target="embeddings/oleObject${n + 1}.bin"/>`)];
  rels = rels.replace('</Relationships>', `${newRels.join('')}</Relationships>`);
  zip.file('word/_rels/document.xml.rels', rels);

  let types = await typesPart.async('string');
  if (!/<Default Extension="bin"/i.test(types)) types = types.replace('</Types>', `<Default Extension="bin" ContentType="${OLE_TYPE}"/></Types>`);
  if (!/<Default Extension="png"/i.test(types)) types = types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
  zip.file('[Content_Types].xml', types);

  zip.file(`word/${ICON_PART}`, Buffer.from(PDF_ICON_PNG_BASE64, 'base64'));
  for (const n of used) zip.file(`word/embeddings/oleObject${n + 1}.bin`, packageObject(packageFileName(embeds[n]!.fileName.replace(/\.pdf$/i, '')), embeds[n]!.pdf));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* A diagram PDF when the browser didn't upload one                                                                                */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/**
 * A one-page PDF of a diagram picture: an A4 page, landscape for a wide diagram, with the title above the picture. Used for a pack whose
 * diagrams were drawn before the browser uploaded each one's PDF as well (an older draft being issued).
 */
export function diagramPdf(png: Buffer, title: string, size: { width: number; height: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = size.width >= size.height;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 28, info: { Title: title, Creator: 'Voxshift' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const m = 28;
      // the standard font has no glyph outside WinAnsi: anything else is "?"
      doc.font('Helvetica').fontSize(9).fillColor('#616161').text(title.replace(/[^\x20-\x7e\xa0-\xff–—]/g, '?'), m, m, { width: doc.page.width - 2 * m });
      const top = m + 18;
      doc.image(png, m, top, { fit: [doc.page.width - 2 * m, doc.page.height - top - m], align: 'center' });
      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}
