import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KUMA_STATUS_PAGE_CSS } from './kuma-branding';

describe('Kuma status page branding', () => {
  it('is the same CSS as deploy/kuma/voxshift-status-page.css', () => {
    expect(KUMA_STATUS_PAGE_CSS).toBe(readFileSync(resolve(__dirname, '../../../deploy/kuma/voxshift-status-page.css'), 'utf8'));
  });
});
