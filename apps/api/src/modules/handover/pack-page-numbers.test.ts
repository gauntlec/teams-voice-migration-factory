import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { headingPages, measuringCopy, ROW_EXTRA, type PackHeading } from './pack-page-numbers';

const h = (number: string, title: string, level: 1 | 2 = 1): PackHeading => ({ number, title, level, anchor: `a${number}` });

describe('pack page numbers', () => {
  it('reads the page of each heading, not its line on the contents page', () => {
    const text = [
      'Cover',
      '1.   Approvals & Sign-Off ........................ 0\n1.1  Document Control ............ 0\n2.   Teams Users .............. 0',
      'header\n1.    Approvals & Sign-Off\ntext\n1.1   Document Control\n',
      'first.last@parker.com\n2.    Teams Users\n',
    ].join('\f');
    const pages = headingPages(text, [h('1.', 'Approvals & Sign-Off'), h('1.1', 'Document Control', 2), h('2.', 'Teams Users')]);
    expect(Object.fromEntries(pages!)).toEqual({ 'a1.': 3, 'a1.1': 3, 'a2.': 4 });
  });

  it('takes the heading, not a table cell or a later section with the same words', () => {
    const text = 'Teams Users are listed\n\f3.  Phone Numbers\n13.  Phone Numbers\f';
    expect(headingPages(text, [h('3.', 'Phone Numbers')])!.get('a3.')).toBe(2);
    // "1." doesn't match "11."
    expect(headingPages('11.  Call Queues\f1.  Call Queues', [h('1.', 'Call Queues')])!.get('a1.')).toBe(2);
  });

  it('keeps going on the same page, for two headings on one page', () => {
    const pages = headingPages('8.  Analogue\n9.  Paging\n10.  Auto\f', [h('8.', 'Analogue'), h('9.', 'Paging'), h('10.', 'Auto')]);
    expect([...pages!.values()]).toEqual([1, 1, 1]);
  });

  it('finds a long title that wraps, and one with characters special to a pattern', () => {
    expect(headingPages('5.  A very long section title that goes on and on\nand wraps', [h('5.', 'A very long section title that goes on and on and wraps')])).not.toBeNull();
    expect(headingPages('7.  Common Area Phones (CAPS)', [h('7.', 'Common Area Phones (CAPS)')])).not.toBeNull();
  });

  it('gives no numbers at all rather than a guess when a heading is missing or out of order', () => {
    expect(headingPages('1.  One\f', [h('1.', 'One'), h('2.', 'Two')])).toBeNull();
    expect(headingPages('2.  Two\f1.  One', [h('1.', 'One'), h('2.', 'Two')])).toBeNull();
  });

  it('makes table rows taller in the measuring copy only', async () => {
    const zip = new JSZip();
    const xml = '<w:tc><w:tcPr><w:tcMar><w:top w:type="dxa" w:w="30"/><w:bottom w:type="dxa" w:w="30"/></w:tcMar></w:tcPr></w:tc>';
    zip.file('word/document.xml', xml);
    const out = await JSZip.loadAsync(await measuringCopy(await zip.generateAsync({ type: 'nodebuffer' })));
    expect(await out.file('word/document.xml')!.async('string')).toBe(xml.replace('<w:top w:type="dxa" w:w="30"/>', `<w:top w:type="dxa" w:w="${30 + ROW_EXTRA}"/>`));
  });
});
