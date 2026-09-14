import { BadRequestException } from '@nestjs/common';

/**
 * Allowlisted upload types for a branding logo (tenant or MSP). Deliberately
 * excludes SVG (script/markup XSS surface) and WebP - classic Outlook
 * desktop (the "Word engine" renderer, still the most common client for
 * this platform's enterprise IT/telecom audience) has no WebP decoder at
 * all, so a WebP logo silently fails to render there while working
 * everywhere else, including in the web app itself and in a quick manual
 * check.
 */
export const LOGO_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/**
 * Minimal, dependency-free width/height reader for PNG/JPEG - just enough
 * to size a logo correctly in email HTML. Unlike the web app (CSS `height`
 * + `width:auto` always scales proportionally in a real browser), Outlook's
 * rendering engine needs an explicit pixel `width` alongside `height`, and
 * does not reliably scale down an oversized source image when only one
 * dimension is given - see apps/worker/src/mail/layout.ts.
 */
export function readImageDimensions(buf: Buffer, contentType: string): { width: number; height: number } {
  if (contentType === 'image/png') {
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } else if (contentType === 'image/jpeg') {
    // Scan JPEG markers for a Start-Of-Frame segment (0xC0-0xCF except the
    // non-frame markers 0xC4/0xC8/0xCC), which carries width/height.
    const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2; // skip the SOI marker (0xFFD8)
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (SOF_MARKERS.has(marker)) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }
  throw new BadRequestException('Could not read image dimensions - the file may be corrupt.');
}
