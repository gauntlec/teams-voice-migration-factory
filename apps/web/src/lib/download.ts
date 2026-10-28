/** Saves text as a file in the browser. `bom` adds the UTF-8 marker Excel needs to read accents, but leave it off for a file another system reads (its first line would be wrong). */
export function downloadText(filename: string, text: string, opts: { mime?: string; bom?: boolean } = {}) {
  const blob = new Blob([opts.bom ? '﻿' : '', text], { type: opts.mime ?? 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
