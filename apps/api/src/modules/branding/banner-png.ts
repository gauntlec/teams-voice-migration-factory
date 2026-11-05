import { deflateSync } from 'node:zlib';

/**
 * The cover banner of a Word document (the handover pack's front page): angled bands in the brand's colours across the top of
 * the page, drawn here and written as a PNG with node's own zlib, so it follows any brand and needs no image library.
 */
type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Is (x, y) inside the polygon (even-odd rule). */
function inside(x: number, y: number, poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A 2400 × 400 banner: a light band, two brand-coloured planes from the right, and a fine grey rule across. */
export function bannerPng(colors: { brand: string; accent: string; tint: string }, width = 2400, height = 400): Buffer {
  const W = width;
  const H = height;
  const layers: { poly: [number, number][]; rgb: Rgb; alpha: number }[] = [
    { poly: [[0, 0], [W, 0], [W, H * 0.78], [0, H * 0.5]], rgb: hex(colors.tint), alpha: 0.55 },
    { poly: [[W * 0.18, 0], [W, 0], [W, H * 0.6], [0, H * 0.5]], rgb: hex(colors.accent), alpha: 0.55 },
    { poly: [[W * 0.5, 0], [W, 0], [W, H * 0.32]], rgb: hex(colors.brand), alpha: 0.85 },
  ];
  const rule = { a: [0, H * 0.97] as [number, number], b: [W, H * 0.62] as [number, number], rgb: [200, 200, 205] as Rgb };
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      let r = 255;
      let g = 255;
      let b = 255;
      for (const l of layers) {
        if (!inside(x + 0.5, y + 0.5, l.poly)) continue;
        r = r * (1 - l.alpha) + l.rgb[0] * l.alpha;
        g = g * (1 - l.alpha) + l.rgb[1] * l.alpha;
        b = b * (1 - l.alpha) + l.rgb[2] * l.alpha;
      }
      // the fine rule: within 1.5 px of the line from a to b
      const ly = rule.a[1] + ((rule.b[1] - rule.a[1]) * x) / W;
      if (Math.abs(y - ly) < 1.5) [r, g, b] = rule.rgb;
      const o = row + 1 + x * 3;
      raw[o] = Math.round(r);
      raw[o + 1] = Math.round(g);
      raw[o + 2] = Math.round(b);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
