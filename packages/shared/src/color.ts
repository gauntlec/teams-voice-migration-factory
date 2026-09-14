/**
 * Turns one customer-picked accent color into the 16-stop ramp Fluent UI v9
 * themes need (`BrandVariants`). Returns a plain object with the same shape
 * rather than importing `@fluentui/react-components` here, so both the web
 * app (feeds this into `createLightTheme`) and the worker (reads a few stops
 * as plain hex for the email HTML) share one implementation and always agree
 * on what a given accent color looks like.
 *
 * There's no published spec for how Fluent generates its own ramps, so this
 * is a tuned approximation: the picked color is reproduced exactly at stop
 * 80 (mirrors how the hand-authored ramp in apps/web/src/theme.ts anchors 80
 * to the current Voxshift brand color), stops 10-70 interpolate lightness
 * down toward near-black, and stops 90-160 interpolate up toward a
 * desaturated near-white tint.
 */

export type ColorRampStop = 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150 | 160;
export type ColorRamp = Record<ColorRampStop, string>;

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return { h: h / 6, s, l };
}

function hueToRgb(p: number, q: number, t0: number): number {
  let t = t0;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToHex({ h, s, l }: Hsl): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    const hex = v.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hueToRgb(p, q, h) * 255);
  const b = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const STOPS: ColorRampStop[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
/** Index of stop 80 in STOPS - where the picked color is reproduced exactly. */
const ANCHOR_INDEX = STOPS.indexOf(80);

export function buildColorRamp(hex: string): ColorRamp {
  const base = hexToHsl(hex);
  const ramp = {} as ColorRamp;
  for (let i = 0; i < STOPS.length; i++) {
    const stop: ColorRampStop = STOPS[i]!;
    if (stop === 80) {
      ramp[stop] = hex;
      continue;
    }
    if (i < ANCHOR_INDEX) {
      // Darker stops: fewer than the anchor - interpolate lightness down
      // toward near-black, keep saturation and hue close to the source.
      const t = (ANCHOR_INDEX - i) / ANCHOR_INDEX;
      ramp[stop] = hslToHex({ h: base.h, s: base.s, l: base.l * (1 - t * 0.92) });
    } else {
      // Lighter stops: interpolate lightness up toward near-white,
      // desaturating as it approaches the lightest stops (160).
      const t = (i - ANCHOR_INDEX) / (STOPS.length - 1 - ANCHOR_INDEX);
      const l = base.l + (0.97 - base.l) * t;
      const s = base.s * (1 - t * 0.55);
      ramp[stop] = hslToHex({ h: base.h, s, l });
    }
  }
  return ramp;
}
