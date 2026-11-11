import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { compoundFile, embedMarker, embedPdfs, guidBytes, packageFileName, packageObject, readCompoundFile, readPackage } from './embedded-pdf';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

describe('embedded PDFs: the OLE compound file', () => {
  it('writes the Package exactly as the document tested in Word does', () => {
    const { rootClsid, streams } = readCompoundFile(packageObject('Sample.pdf', PDF));
    expect(rootClsid).toEqual(guidBytes('0003000C-0000-0000-C000-000000000046'));
    expect([...streams.keys()].sort()).toEqual(['\u0001CompObj', '\u0001Ole10Native', '\u0001Sh33tJ5', '\u0003ObjInfo']);
    // the tested document's streams, byte for byte
    expect(streams.get('\u0001CompObj')!.toString('hex')).toBe(
      '0100feff030a0000ffffffff0c00030000000000c0000000000000460c0000004f4c45205061636b616765000000000008000000' + '5061636b61676500f439b271000000000000000000000000',
    );
    expect(streams.get('\u0003ObjInfo')!.toString('hex')).toBe('000003000d00');
    expect(streams.get('\u0001Sh33tJ5')!.toString('latin1')).toBe('7262');
    const native = streams.get('\u0001Ole10Native')!;
    expect(native.readUInt32LE(0)).toBe(native.length - 4);
    expect(readPackage(native)).toEqual({ fileName: 'Sample.pdf', data: PDF });
    expect(native.includes(Buffer.from('C:\\Temp\\Sample.pdf\0', 'latin1'))).toBe(true);
  });

  it('carries a large PDF in normal sectors, past the 109 FAT sectors the header can list', () => {
    const big = Buffer.concat([PDF, Buffer.alloc(9_000_000, 0x20)]); // ~17,600 sectors: 138 FAT sectors, so a DIFAT sector
    const bin = packageObject('Big.pdf', big);
    expect(bin.readUInt32LE(72)).toBeGreaterThan(0); // DIFAT sectors
    expect(readPackage(readCompoundFile(bin).streams.get('\u0001Ole10Native')!).data.equals(big)).toBe(true);
  });

  it('keeps small streams in the mini stream and a stream of exactly 4096 bytes in normal sectors', () => {
    const streams = [
      { name: 'a', data: Buffer.alloc(1, 1) },
      { name: 'bb', data: Buffer.alloc(4095, 2) },
      { name: 'ccc', data: Buffer.alloc(4096, 3) },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const read = readCompoundFile(compoundFile(streams, '00000000-0000-0000-0000-000000000000')).streams;
    for (const s of streams) expect(read.get(s.name)!.equals(s.data)).toBe(true);
  });

  it('names the file in plain ASCII without the characters Windows refuses', () => {
    expect(packageFileName('Call Flow Diagram - Zürich: Main/Reception?', '.pdf')).toBe('Call Flow Diagram - Zurich- Main-Reception-.pdf');
    expect(packageFileName('Café – 日本', '.pdf')).toBe('Cafe - __.pdf');
    expect(packageFileName('   ', '.pdf')).toBe('Attachment.pdf');
    expect(packageFileName('x'.repeat(300)).length).toBe(120);
  });
});

describe('embedded PDFs: in the .docx', () => {
  const docx = async (paragraphs: string[]) => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file(
      'word/document.xml',
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: 'nodebuffer' });
  };

  it('swaps each marker for the object, with its parts, relationships, content type and namespaces', async () => {
    const out = await JSZip.loadAsync(await embedPdfs(await docx(['before', embedMarker(0), 'between', embedMarker(1)]), [{ fileName: 'One.pdf', pdf: PDF }, { fileName: 'Two.pdf', pdf: PDF }]));
    const xml = await out.file('word/document.xml')!.async('string');
    expect(xml).not.toContain('__VXS_EMBED_');
    expect(xml).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(xml).toContain('xmlns:o="urn:schemas-microsoft-com:office:office"');
    expect(xml.match(/<o:OLEObject Type="Embed" ProgID="Package" ShapeID="_x0000_i200\d" DrawAspect="Icon" ObjectID="_\d+" r:id="rIdVxsOle\d"\/>/g)).toHaveLength(2);
    expect(xml).toContain('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">before</w:t></w:r></w:p><w:p><w:r><w:object ');
    const rels = await out.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('Id="rIdVxsPdfIcon" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/vxs-pdf-icon.png"');
    expect(rels).toContain('Id="rIdVxsOle2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject2.bin"');
    const types = await out.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>');
    expect(types).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(readPackage(readCompoundFile(await out.file('word/embeddings/oleObject2.bin')!.async('nodebuffer')).streams.get('\u0001Ole10Native')!).fileName).toBe('Two.pdf');

    // the icon is a whole PNG: 120 × 150 RGB, its picture data inflating to every row, and nothing after IEND
    const icon = await out.file('word/media/vxs-pdf-icon.png')!.async('nodebuffer');
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([120, 150]);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let i = 8; i < icon.length; ) {
      const n = icon.readUInt32BE(i);
      chunks.push({ type: icon.subarray(i + 4, i + 8).toString('latin1'), data: icon.subarray(i + 8, i + 8 + n) });
      i += 12 + n;
      if (i > icon.length) throw new Error('chunk runs past the end');
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(inflateSync(chunks[1]!.data).length).toBe((120 * 3 + 1) * 150);
  });

  it('leaves a document without markers as it was', async () => {
    const plain = await docx(['nothing to embed']);
    expect((await embedPdfs(plain, [{ fileName: 'x.pdf', pdf: PDF }])).equals(plain)).toBe(true);
    expect((await embedPdfs(plain, [])).equals(plain)).toBe(true);
  });
});
