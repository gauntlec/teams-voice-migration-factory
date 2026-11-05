/**
 * The column widths of a handover pack's data table, worked out from what is in the table. A short value such as a voice routing
 * policy stays on one line whenever the page has room for it. The room goes first to what Word can't break (a word up to a hyphen),
 * then to each column's longest word (a UPN or a policy name has no spaces), then to its longest value, then to its title, narrowest
 * first each time - so what wraps is the longest text in the table, never a short value beside it. Widths and font sizes here are as
 * Word has them: twentieths of a point, half points.
 */

/** Calibri's character widths, as a part of the font size (its own metrics). Anything else counts as a wide capital. */
const CALIBRI: Record<string, number> = {
  a: 0.479, b: 0.525, c: 0.423, d: 0.525, e: 0.498, f: 0.305, g: 0.471, h: 0.525, i: 0.229, j: 0.239, k: 0.455, l: 0.229, m: 0.799,
  n: 0.525, o: 0.527, p: 0.525, q: 0.525, r: 0.349, s: 0.391, t: 0.335, u: 0.525, v: 0.452, w: 0.715, x: 0.433, y: 0.453, z: 0.395,
  A: 0.579, B: 0.544, C: 0.533, D: 0.615, E: 0.488, F: 0.459, G: 0.631, H: 0.623, I: 0.252, J: 0.319, K: 0.52, L: 0.42, M: 0.855,
  N: 0.646, O: 0.662, P: 0.517, Q: 0.673, R: 0.543, S: 0.459, T: 0.487, U: 0.642, V: 0.567, W: 0.89, X: 0.519, Y: 0.487, Z: 0.468,
  ' ': 0.226, '-': 0.306, '.': 0.252, ',': 0.25, ':': 0.268, ';': 0.268, '/': 0.386, '\\': 0.386, '@': 0.894, '_': 0.498, '+': 0.498,
  '(': 0.303, ')': 0.303, '&': 0.682, "'": 0.221, '#': 0.498, '%': 0.715, '=': 0.498, '—': 0.905, '–': 0.498, '*': 0.498,
};
for (const d of '0123456789') CALIBRI[d] = 0.507;

/** The cell's margins and borders, as dataTable draws them. */
const CELL_PADDING = 230;
/** Bold is a little wider, and Word's line breaking leaves a little over: better a column slightly wide than a value wrapped. */
const BOLD = 1.04;
const SAFETY = 1.05;

function textWidth(t: string, size: number, bold: boolean): number {
  let em = 0;
  for (const ch of t) em += CALIBRI[ch] ?? 0.7;
  return Math.ceil(em * size * 10 * SAFETY * (bold ? BOLD : 1)) + CELL_PADDING;
}

const lines = (v: string) => (v || '—').split('\n');
const words = (v: string) => v.split(/\s+/).filter(Boolean);
/** Word can end a line after a hyphen: this is the least a word needs without being broken mid-word. */
const parts = (v: string) => words(v).flatMap((w) => w.split(/(?<=-)/));
const longest = (values: string[], size: number, bold: boolean) => values.reduce((m, v) => Math.max(m, textWidth(v, size, bold)), CELL_PADDING);

/** What each column needs: its longest unbreakable part, its longest word (each with the title's), its longest value, and its title on one line. */
function measure(columns: string[], rows: string[][], size: number) {
  return columns.map((title, i) => {
    const values = rows.flatMap((r) => lines(r[i] ?? ''));
    const part = Math.max(longest(parts(title), size, true), longest(values.flatMap(parts), size, false));
    const word = Math.max(longest(words(title), size, true), longest(values.flatMap(words), size, false));
    const value = Math.max(word, longest(values, size, false));
    return { part, word, value, full: Math.max(value, longest([title], size, true)) };
  });
}

/** Raises the columns towards what they want. When there isn't room for all of it the narrowest wants are met first, so the longest text is what wraps. */
function raise(widths: number[], wants: number[], total: number): number[] {
  const at = (level: number) => widths.map((w, i) => Math.max(w, Math.min(wants[i]!, level)));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  if (sum(at(Number.MAX_SAFE_INTEGER)) <= total) return at(Number.MAX_SAFE_INTEGER);
  let low = 0;
  let high = total;
  for (let n = 0; n < 40; n++) {
    const mid = (low + high) / 2;
    if (sum(at(mid)) > total) high = mid;
    else low = mid;
  }
  return at(low);
}

/** Widths that add up to the table's width, in whole units. */
function share(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = weights.map((w) => Math.floor((w / sum) * total));
  out[out.length - 1]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** Can the table be drawn at this size without breaking a word mid-way? One that can't steps down a size. */
export function wordsFit(columns: string[], rows: string[][], total: number, size: number): boolean {
  return measure(columns, rows, size).reduce((a, c) => a + c.part, 0) <= total;
}

export function columnWidths(columns: string[], rows: string[][], total: number, size: number): number[] {
  const m = measure(columns, rows, size);
  const least = m.map((c) => c.part);
  if (least.reduce((a, b) => a + b, 0) >= total) return share(least, total);
  const whole = raise(least, m.map((c) => c.word), total);
  const values = raise(whole, m.map((c) => c.value), total);
  // what is over at the end goes round in proportion, so a table with short values still fills the page's width
  return share(raise(values, m.map((c) => c.full), total), total);
}
