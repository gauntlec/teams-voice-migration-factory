import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KUMA_STATUS_PAGE_CSS, KUMA_STATUS_PAGE_CSS_MARKER, KUMA_STATUS_PAGE_LOGO_DATA_URL } from './kuma-branding';

describe('Kuma status page branding', () => {
  it('is the same CSS as deploy/kuma/voxshift-status-page.css', () => {
    expect(KUMA_STATUS_PAGE_CSS).toBe(readFileSync(resolve(__dirname, '../../../deploy/kuma/voxshift-status-page.css'), 'utf8'));
  });

  it('starts with the marker Voxshift uses to recognise its own CSS', () => {
    expect(KUMA_STATUS_PAGE_CSS.startsWith(KUMA_STATUS_PAGE_CSS_MARKER)).toBe(true);
  });

  it('carries the same logo bytes as deploy/kuma/voxshift-logo.png, as a PNG data URL', () => {
    const file = readFileSync(resolve(__dirname, '../../../deploy/kuma/voxshift-logo.png'));
    expect(KUMA_STATUS_PAGE_LOGO_DATA_URL).toBe(`data:image/png;base64,${file.toString('base64')}`);
    expect(file.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
