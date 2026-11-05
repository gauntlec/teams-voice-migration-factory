import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import JSZip from 'jszip';

const run = promisify(execFile);

/** One numbered heading of a pack, as its contents page lists it. */
export interface PackHeading {
  level: 1 | 2;
  /** as printed: "6." or "6.1" */
  number: string;
  title: string;
  /** the bookmark on the heading, that the contents line links to */
  anchor: string;
}

/**
 * How much taller Word draws a table row than LibreOffice, in twentieths of a point: Word fits 38 rows on a page where LibreOffice
 * fits 39, so without this the page numbers drift by one row a page. Only the measuring copy gets it, never the pack itself.
 */
export const ROW_EXTRA = 10;

/** A pack with every table row made as tall as Word draws it, for LibreOffice to lay out. */
export async function measuringCopy(docx: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx);
  const part = zip.file('word/document.xml');
  if (!part) return docx;
  const xml = await part.async('string');
  zip.file('word/document.xml', xml.replace(/(<w:tcMar><w:top [^>]*?w:w=")(\d+)"/g, (_, start: string, top: string) => `${start}${Number(top) + ROW_EXTRA}"`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Text to match exactly in a pattern, whatever characters it has. */
const literal = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which page each heading is on, from pdftotext's output (a form feed between pages). A heading is a line starting with its number and
 * title; a contents line is the same but has dot leaders, so it doesn't count. Null unless every heading is found in order: a pack's
 * contents would rather show no page numbers than a guess.
 */
export function headingPages(pdfText: string, headings: readonly PackHeading[]): Map<string, number> | null {
  const pages = pdfText.split('\f');
  const found = new Map<string, number>();
  let page = 0;
  let line = 0;
  for (const h of headings) {
    const start = new RegExp(`^\\s*${literal(h.number)}\\s+${literal(h.title.trim().slice(0, 40)).replace(/\s+/g, '\\s+')}`);
    let hit = false;
    while (!hit && page < pages.length) {
      const lines = pages[page]!.split('\n');
      for (; line < lines.length; line++) {
        if (start.test(lines[line]!) && !/\.{4,}/.test(lines[line]!)) {
          found.set(h.anchor, page + 1);
          line++;
          hit = true;
          break;
        }
      }
      if (!hit) {
        page++;
        line = 0;
      }
    }
    if (!hit) return null;
  }
  return found;
}

/**
 * The page numbers for a pack's contents page. Word can only work them out itself by warning everyone who opens the pack ("fields that
 * may refer to other files"), so the API lays the pack out once with LibreOffice and writes the numbers in. They can differ from
 * Word's now and then (90 of 96 headings matched across four test packs, the others one page out, on 5 Nov 2026); right-click >
 * Update Field in Word puts them right. Anything going wrong here costs the page numbers, never the pack.
 */
@Injectable()
export class PackPageNumbers {
  private readonly log = new Logger('PackPageNumbers');
  /** LibreOffice runs one pack at a time: it is heavy, and packs are generated rarely. */
  private queue: Promise<unknown> = Promise.resolve();

  locate(docx: Buffer, headings: readonly PackHeading[]): Promise<Map<string, number> | null> {
    const job = this.queue.then(() => this.measure(docx, headings));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async measure(docx: Buffer, headings: readonly PackHeading[]): Promise<Map<string, number> | null> {
    const dir = await mkdtemp(join(tmpdir(), 'pack-pages-'));
    try {
      await writeFile(join(dir, 'pack.docx'), await measuringCopy(docx));
      // its own profile each time, in the folder that is thrown away, and a limit so a very large pack can't hold up its generation for long
      await run('soffice', [`-env:UserInstallation=file://${join(dir, 'profile')}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, 'pack.docx')], { timeout: 60_000, killSignal: 'SIGKILL' });
      await run('pdftotext', ['-layout', join(dir, 'pack.pdf'), join(dir, 'pack.txt')], { timeout: 30_000, killSignal: 'SIGKILL' });
      const pages = headingPages(await readFile(join(dir, 'pack.txt'), 'utf8'), headings);
      if (!pages) this.log.warn('a heading was not found in the laid-out pack: its contents page has no page numbers');
      return pages;
    } catch (e) {
      this.log.warn(`could not lay the pack out, so its contents page has no page numbers: ${(e as Error).message}`);
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
