import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Badge,
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { Dialog } from './AppDialog';
import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { MAX_RANGE_SIZE, NUMBER_RANGE_KIND_LABELS, NUMBER_RANGE_KINDS, type NumberRangeKind } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { DataTable } from './DataTable';
import { DangerText } from './ui';

/**
 * Bulk-add number ranges to a Site Data site from an xlsx/csv with the
 * columns DID-START and DID-END, and optionally NUMBER TRANSITION, CARRIER,
 * NEW CARRIER and COMMENTS per row (bug report "Number Range Import from
 * Excel"); a blank cell takes the choice made on screen. Parsing and the template are done in the
 * browser with a lazy-loaded SheetJS (same approach as ImportUsersDialog) - the
 * API only ever sees validated rows.
 */

const useStyles = makeStyles({
  surface: { maxWidth: '820px', width: '94vw' },
  body: { display: 'grid', ...shorthands.gap('12px'), minWidth: '600px' },
  drop: {
    ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding('20px'),
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
  },
  summary: { display: 'flex', ...shorthands.gap('8px'), flexWrap: 'wrap', alignItems: 'center' },
  options: { display: 'grid', gridTemplateColumns: '180px 1fr', ...shorthands.gap('12px') },
  scroll: { maxHeight: '40vh', overflowY: 'auto' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** What each stored range kind is called on screen in this dialog. */
const RANGE_TYPE_LABEL: Record<NumberRangeKind, string> = NUMBER_RANGE_KIND_LABELS;

const START_HEADERS = ['did-start', 'did start', 'did_start', 'didstart', 'start', 'range start', 'from'];
const END_HEADERS = ['did-end', 'did end', 'did_end', 'didend', 'end', 'range end', 'to'];

const KIND_HEADERS = ['number transition', 'number-transition', 'transition', 'type', 'kind'];
const CARRIER_HEADERS = ['carrier', 'current carrier'];
const NEW_CARRIER_HEADERS = ['new carrier', 'new-carrier', 'new_carrier', 'moving to'];
const COMMENTS_HEADERS = ['comments', 'comment', 'notes'];

const TEMPLATE_COLUMNS = ['DID-START', 'DID-END', 'NUMBER TRANSITION', 'CARRIER', 'NEW CARRIER', 'COMMENTS'];
const TEMPLATE_EXAMPLES = [
  ['+441234567000', '+441234567099', 'Port', 'BT', 'Gamma', 'Main DDI block'],
  ['+441234568000', '+441234568009', 'New', 'Gamma', '', ''],
  ['+441234569100', '+441234569100', 'Re-point', 'BT', '', 'Fax line'],
];

/** "Port", "re-point", "Repoint", "retain", "new" -> the stored kind; '' when the cell is blank; null when it can't be read. */
function readKind(raw: unknown): NumberRangeKind | '' | null {
  const v = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!v) return '';
  if (v === 'new') return 'new';
  if (v === 'port' || v === 'portin') return 'port';
  if (v === 'repoint' || v === 'retain' || v === 'repointed') return 'retain';
  return null;
}

type Parsed = {
  n: number;
  start: string;
  end: string;
  /** the row's own values: blank ones take the choices made on screen */
  kind?: NumberRangeKind;
  carrier?: string;
  newCarrier?: string;
  comments?: string;
  count: number;
  status: 'ok' | 'warn' | 'error';
  notes: string[];
};

/** "+44 (0) 1234-567000" -> "+441234567000"-style: keep digits, and a leading +. */
function cleanNumber(raw: unknown): string {
  const t = String(raw ?? '').trim();
  const digits = t.replace(/\D/g, '');
  return digits ? (t.startsWith('+') ? '+' : '') + digits : '';
}

export function ImportRangesDialog({
  base,
  siteId,
  onClose,
  onDone,
}: {
  base: string;
  siteId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const s = useStyles();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<NumberRangeKind>('new');
  const [carrier, setCarrier] = useState('');
  const [newCarrier, setNewCarrier] = useState('');
  const [result, setResult] = useState<{
    created: number;
    numbers: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateDone, setTemplateDone] = useState(false);

  const loadXlsx = () => import('xlsx');

  const validRows = useMemo(() => (parsed ?? []).filter((p) => p.status !== 'error'), [parsed]);
  const totalNumbers = validRows.reduce((sum, p) => sum + p.count, 0);
  // every Port row has a new carrier: its own, or the one entered on screen
  const portRowsCovered = validRows.every((p) => (p.kind ?? kind) !== 'port' || !!p.newCarrier || !!newCarrier.trim());

  async function handleFile(file: File) {
    setErr(null);
    setResult(null);
    setParsing(true);
    setFileName(file.name);
    try {
      const XLSX = await loadXlsx();
      // raw: keep csv cells as text so leading zeros survive.
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '', raw: false });
      if (!grid.length) throw new Error('The sheet is empty.');
      const headerRow = grid[0].map((h) => String(h ?? '').trim().toLowerCase());
      const si = headerRow.findIndex((h) => START_HEADERS.includes(h));
      const ei = headerRow.findIndex((h) => END_HEADERS.includes(h));
      if (si < 0 || ei < 0) {
        throw new Error('The first row must have the column headings DID-START and DID-END.');
      }
      const col = (names: string[]) => headerRow.findIndex((h) => names.includes(h));
      const ki = col(KIND_HEADERS);
      const ci = col(CARRIER_HEADERS);
      const ni = col(NEW_CARRIER_HEADERS);
      const mi = col(COMMENTS_HEADERS);
      const cell = (cells: unknown[], i: number) => (i < 0 ? '' : String(cells[i] ?? '').trim());

      const out: Parsed[] = [];
      const seen: { n: number; s: bigint; e: bigint }[] = [];
      for (let r = 1; r < grid.length; r++) {
        const cells = grid[r];
        if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
        const start = cleanNumber(cells[si]);
        const end = cleanNumber(cells[ei]);
        const notes: string[] = [];
        let status: Parsed['status'] = 'ok';
        let count = 0;
        const sd = start.replace(/\D/g, '');
        const ed = end.replace(/\D/g, '');
        if (!sd || !ed) {
          status = 'error';
          notes.push('DID-START and DID-END are both needed');
        } else if (sd.length !== ed.length) {
          status = 'error';
          notes.push('start and end must have the same number of digits');
        } else if (sd.length < 3 || sd.length > 19) {
          status = 'error';
          notes.push('numbers must be 3 to 19 digits');
        } else {
          const b0 = BigInt(sd);
          const b1 = BigInt(ed);
          if (b1 < b0) {
            status = 'error';
            notes.push('DID-END is before DID-START');
          } else if (b1 - b0 + 1n > BigInt(MAX_RANGE_SIZE)) {
            status = 'error';
            notes.push(`over ${MAX_RANGE_SIZE} numbers — split it into smaller ranges`);
          } else {
            count = Number(b1 - b0 + 1n);
            const clash = seen.find((x) => b0 <= x.e && x.s <= b1);
            if (clash) {
              status = 'warn';
              notes.push(`overlaps row ${clash.n} — numbers already added are skipped`);
            }
            seen.push({ n: r + 1, s: b0, e: b1 });
          }
        }
        const kindCell = ki < 0 ? '' : readKind(cells[ki]);
        if (kindCell === null) {
          status = 'error';
          notes.push(`NUMBER TRANSITION "${cell(cells, ki)}" isn't New, Port or Re-point`);
        }
        out.push({
          n: r + 1,
          start,
          end,
          count,
          status,
          notes,
          ...(kindCell ? { kind: kindCell } : {}),
          ...(cell(cells, ci) ? { carrier: cell(cells, ci).slice(0, 160) } : {}),
          ...(cell(cells, ni) ? { newCarrier: cell(cells, ni).slice(0, 160) } : {}),
          ...(cell(cells, mi) ? { comments: cell(cells, mi).slice(0, 2000) } : {}),
        });
      }
      if (!out.length) throw new Error('No data rows below the header.');
      if (out.length > 500) throw new Error('A file can hold up to 500 ranges. Split it and import in more than one go.');
      setParsed(out);
    } catch (e) {
      setParsed(null);
      setErr(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setParsing(false);
    }
  }

  async function downloadTemplate() {
    setErr(null);
    setTemplateBusy(true);
    try {
      const XLSX = await loadXlsx();
      const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS, ...TEMPLATE_EXAMPLES]);
      ws['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 30 }];
      const notes = XLSX.utils.aoa_to_sheet([
        ['Column', 'Required', 'Notes'],
        ['DID-START', 'Yes', 'First number in the range. E.164 (+441234567000) is best. Keep the cells formatted as Text so leading zeros are not lost.'],
        ['DID-END', 'Yes', `Last number in the range, with the same number of digits as DID-START. A single number has the same value in both columns. A range can hold up to ${MAX_RANGE_SIZE} numbers.`],
        ['NUMBER TRANSITION', 'No', 'New, Port or Re-point. Leave it blank to use the choice made on screen when you import.'],
        ['CARRIER', 'No', 'Where the numbers are now. Blank uses the carrier entered on screen, if any.'],
        ['NEW CARRIER', 'For a port', 'The carrier the numbers are moving to. A Port row needs one here or on screen.'],
        ['COMMENTS', 'No', 'Anything worth noting about the range.'],
        [],
        ['Replace the three example rows on the first sheet with your own, one range per row.'],
        ['Numbers that are already in the inventory are skipped, so it is safe to import the same file twice.'],
        ['After importing, tick ranges on the Number ranges list and use "Change selected" to change several at once.'],
      ]);
      notes['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 100 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Ranges');
      XLSX.utils.book_append_sheet(wb, notes, 'How to fill this in');
      XLSX.writeFile(wb, 'voxshift-number-ranges-template.xlsx');
      setTemplateDone(true);
      setTimeout(() => setTemplateDone(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not build the template file.');
    } finally {
      setTemplateBusy(false);
    }
  }

  const importMut = useMutation({
    mutationFn: () =>
      api<{ created: number; numbers: number; skipped: number; errors: { row: number; message: string }[] }>(
        `${base}/number-ranges/import`,
        {
          method: 'POST',
          body: JSON.stringify({
            site_id: siteId,
            kind,
            ...(carrier.trim() ? { carrier: carrier.trim() } : {}),
            ...(kind === 'port' ? { new_carrier: newCarrier.trim() } : {}),
            rows: validRows.map((p) => ({
              range_start: p.start,
              range_end: p.end,
              ...(p.kind ? { kind: p.kind } : {}),
              ...(p.carrier ? { carrier: p.carrier } : {}),
              ...(p.newCarrier ? { new_carrier: p.newCarrier } : {}),
              ...(p.comments ? { comments: p.comments } : {}),
            })),
          }),
        },
      ),
    onSuccess: (r) => {
      // Row numbers from the API count the rows we sent; show the spreadsheet row instead.
      setResult({ ...r, errors: r.errors.map((e) => ({ ...e, row: validRows[e.row - 1]?.n ?? e.row })) });
      onDone();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Import failed'),
  });

  const counts = useMemo(() => {
    const c = { ok: 0, warn: 0, error: 0 };
    for (const p of parsed ?? []) c[p.status] += 1;
    return c;
  }, [parsed]);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Import number ranges from a spreadsheet</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.summary}>
                <Button
                  size="small"
                  icon={templateBusy ? <Spinner size="tiny" /> : <ArrowDownloadRegular />}
                  disabled={templateBusy}
                  onClick={downloadTemplate}
                >
                  {templateDone ? 'Downloaded' : 'Download template'}
                </Button>
                <Text className={s.muted}>.xlsx or .csv · first row is the header · columns DID-START and DID-END, and optionally NUMBER TRANSITION, CARRIER, NEW CARRIER, COMMENTS</Text>
              </div>

              <div className={s.options}>
                <Field label="Number transition (rows that leave it blank)">
                  <Select value={kind} onChange={(_, d) => setKind(d.value as NumberRangeKind)}>
                    {NUMBER_RANGE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {RANGE_TYPE_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={kind === 'port' ? 'Current carrier (optional, rows that leave it blank)' : 'Carrier (optional, rows that leave it blank)'}>
                  <Input value={carrier} onChange={(_, d) => setCarrier(d.value)} maxLength={160} />
                </Field>
                {(kind === 'port' || validRows.some((p) => p.kind === 'port')) && (
                  <Field label="New carrier (rows that leave it blank)" required={!portRowsCovered} hint="The carrier the numbers are moving to. When the port completes, the range's carrier switches to this one." style={{ gridColumn: '1 / -1' }}>
                    <Input value={newCarrier} onChange={(_, d) => setNewCarrier(d.value)} maxLength={160} />
                  </Field>
                )}
              </div>

              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = '';
                }}
              />
              <div
                className={s.drop}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) void handleFile(f);
                }}
              >
                {parsing ? (
                  <Spinner size="tiny" label="Reading…" />
                ) : fileName ? (
                  <>
                    Loaded <b>{fileName}</b> — click to choose another
                  </>
                ) : (
                  <>Click to choose a file, or drop it here</>
                )}
              </div>

              {err && <DangerText>{err}</DangerText>}

              {result && (
                <div style={{ display: 'grid', gap: 4 }}>
                  <Text>
                    Added <b>{result.created}</b> range{result.created === 1 ? '' : 's'} (<b>{result.numbers}</b> numbers
                    in the inventory) · skipped <b>{result.skipped}</b> already in the inventory
                    {result.errors.length ? ` · ${result.errors.length} failed` : ''}.
                  </Text>
                  {result.errors.map((e) => (
                    <DangerText key={e.row}>
                      Row {e.row}: {e.message}
                    </DangerText>
                  ))}
                </div>
              )}

              {parsed && !result && (
                <>
                  <div className={s.summary}>
                    <Badge appearance="tint" color="success">{counts.ok} ready</Badge>
                    {counts.warn > 0 && <Badge appearance="tint" color="warning">{counts.warn} overlapping</Badge>}
                    {counts.error > 0 && <Badge appearance="tint" color="danger">{counts.error} skipped (errors)</Badge>}
                    <Text className={s.muted}>{totalNumbers} numbers in total</Text>
                  </div>
                  <div className={s.scroll}>
                    <DataTable size="small" minWidth={760}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Row</TableHeaderCell>
                          <TableHeaderCell>DID-START</TableHeaderCell>
                          <TableHeaderCell>DID-END</TableHeaderCell>
                          <TableHeaderCell>Numbers</TableHeaderCell>
                          <TableHeaderCell>Transition</TableHeaderCell>
                          <TableHeaderCell>Carrier</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parsed.map((p) => (
                          <TableRow key={p.n}>
                            <TableCell>{p.n}</TableCell>
                            <TableCell>{p.start || '—'}</TableCell>
                            <TableCell>{p.end || '—'}</TableCell>
                            <TableCell>{p.count || '—'}</TableCell>
                            <TableCell>{RANGE_TYPE_LABEL[p.kind ?? kind]}{p.kind ? '' : ' (on screen)'}</TableCell>
                            <TableCell>
                              {(p.kind ?? kind) === 'port'
                                ? `${p.carrier || carrier.trim() || '?'} → ${p.newCarrier || newCarrier.trim() || 'new carrier needed'}`
                                : p.carrier || carrier.trim() || '—'}
                            </TableCell>
                            <TableCell>
                              <Badge
                                appearance="tint"
                                size="small"
                                color={p.status === 'ok' ? 'success' : p.status === 'error' ? 'danger' : 'warning'}
                              >
                                {p.status === 'ok' ? 'Ready' : p.notes.join(' · ')}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  </div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {result ? 'Close' : 'Cancel'}
            </Button>
            {parsed && !result && (
              <Button
                appearance="primary"
                icon={<ArrowUploadRegular />}
                disabled={validRows.length === 0 || importMut.isPending || !portRowsCovered}
                onClick={() => {
                  setErr(null);
                  importMut.mutate();
                }}
              >
                {importMut.isPending
                  ? 'Importing…'
                  : `Import ${validRows.length} range${validRows.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
