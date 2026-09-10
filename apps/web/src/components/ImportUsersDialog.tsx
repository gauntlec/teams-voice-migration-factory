import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
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
import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { api, ApiError } from '../api';
import { DataTable } from './DataTable';

/**
 * Import users into a Data Collection site from an xlsx/csv. Parsing and the
 * template are done in the browser with a lazy-loaded SheetJS - the API only
 * ever sees validated JSON rows. See feature request "Import from Excel".
 */

const useStyles = makeStyles({
  body: { display: 'grid', ...shorthands.gap('12px'), minWidth: '640px' },
  drop: {
    ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding('20px'),
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
  },
  summary: { display: 'flex', ...shorthands.gap('8px'), flexWrap: 'wrap', alignItems: 'center' },
  scroll: { maxHeight: '46vh', overflowY: 'auto' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** canonical field -> accepted header names (lower-case, trimmed) */
const HEADER_ALIASES: Record<string, string[]> = {
  upn: ['upn', 'user principal name', 'userprincipalname', 'email', 'username', 'sign-in name'],
  requested_number: ['phone number', 'phone', 'number', 'telephone', 'telephone number', 'did', 'line uri', 'lineuri', 'msisdn'],
  display_name: ['display name', 'name', 'full name', 'displayname'],
  calling_policy: ['calling policy', 'policy', 'calling policy name'],
  caller_id: ['caller id', 'callerid', 'clid', 'calling line id'],
  voicemail_enabled: ['voicemail enabled', 'voicemail', 'vm', 'voicemail?'],
  voicemail_language: ['voicemail language', 'vm language', 'voicemail lang'],
  requires_handset: ['requires handset', 'handset', 'physical handset', 'requires a physical handset'],
  handset_model: ['handset model', 'model', 'device model'],
  access_port_id: ['access port id', 'access port', 'port', 'ata port'],
  comments: ['comments', 'notes', 'comment', 'note'],
};
const TEMPLATE_COLUMNS = [
  'UPN',
  'Phone number',
  'Display name',
  'Calling policy',
  'Caller ID',
  'Voicemail enabled',
  'Voicemail language',
  'Requires handset',
  'Handset model',
  'Access port ID',
  'Comments',
];
const TEMPLATE_EXAMPLE = [
  'jane.doe@customer.com',
  '+441234567890',
  'Jane Doe',
  'UK-Standard',
  'user',
  'yes',
  'English (United Kingdom)',
  'no',
  '',
  '',
  'Ported from legacy PBX',
];

const numKey = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

type Row = Record<string, string>;
type Parsed = {
  n: number;
  row: Row;
  status: 'ok' | 'warn' | 'error';
  notes: string[];
};

export function ImportUsersDialog({
  base,
  siteId,
  availableE164,
  policyNames,
  onClose,
  onDone,
}: {
  base: string;
  siteId: string;
  availableE164: string[];
  policyNames: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const s = useStyles();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number; errors: { row: number; message: string }[] } | null>(null);

  const freeNumKeys = useMemo(() => new Set(availableE164.map(numKey)), [availableE164]);
  const policySet = useMemo(() => new Set(policyNames.map((p) => p.trim().toLowerCase())), [policyNames]);

  const loadXlsx = () => import('xlsx');

  const validRows = useMemo(
    () => (parsed ?? []).filter((p) => p.status !== 'error').map((p) => p.row),
    [parsed],
  );

  async function handleFile(file: File) {
    setErr(null);
    setResult(null);
    setParsing(true);
    setFileName(file.name);
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' });
      if (!grid.length) throw new Error('The sheet is empty.');
      const headerRow = grid[0].map((h) => String(h ?? '').trim().toLowerCase());
      const colOf: Record<string, number> = {};
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        const i = headerRow.findIndex((h) => aliases.includes(h));
        if (i >= 0) colOf[field] = i;
      }
      if (colOf.upn === undefined) throw new Error('No "UPN" column found in the first row.');

      const out: Parsed[] = [];
      for (let r = 1; r < grid.length; r++) {
        const cells = grid[r];
        if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
        const get = (f: string) => (colOf[f] === undefined ? '' : String(cells[colOf[f]] ?? '').trim());
        const row: Row = {};
        for (const f of Object.keys(HEADER_ALIASES)) {
          const v = get(f);
          if (v) row[f] = v;
        }
        const notes: string[] = [];
        let status: Parsed['status'] = 'ok';
        if (!row.upn || !isEmail(row.upn)) {
          status = 'error';
          notes.push('missing or invalid UPN');
        }
        if (row.requested_number && !freeNumKeys.has(numKey(row.requested_number))) {
          if (status !== 'error') status = 'warn';
          notes.push('number not free in this site’s inventory — flag for Design & Build');
        }
        if (row.calling_policy && !policySet.has(row.calling_policy.toLowerCase())) {
          if (status !== 'error') status = 'warn';
          notes.push(`calling policy “${row.calling_policy}” unknown — imported without one`);
        }
        out.push({ n: r + 1, row, status, notes });
      }
      if (!out.length) throw new Error('No data rows below the header.');
      setParsed(out);
    } catch (e) {
      setParsed(null);
      setErr(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setParsing(false);
    }
  }

  async function downloadTemplate() {
    const XLSX = await loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS, TEMPLATE_EXAMPLE]);
    ws['!cols'] = TEMPLATE_COLUMNS.map(() => ({ wch: 22 }));
    const notes = XLSX.utils.aoa_to_sheet([
      ['Column', 'Required', 'Notes'],
      ['UPN', 'Yes', 'The user’s Microsoft 365 sign-in address.'],
      ['Phone number', 'Yes', 'The number the customer wants. E.164 (+441234567890) is best. If it isn’t already in this site’s number ranges it’s still imported and flagged for Design & Build.'],
      ['Display name', 'No', ''],
      ['Calling policy', 'No', 'Name of an existing calling policy for this customer. Unknown names are ignored.'],
      ['Caller ID', 'No', 'user | anonymous | main number'],
      ['Voicemail enabled', 'No', 'yes / no (defaults to yes)'],
      ['Voicemail language', 'No', ''],
      ['Requires handset', 'No', 'yes / no'],
      ['Handset model', 'No', ''],
      ['Access port ID', 'No', ''],
      ['Comments', 'No', ''],
    ]);
    notes['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 80 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    XLSX.utils.book_append_sheet(wb, notes, 'How to fill this in');
    XLSX.writeFile(wb, 'voxshift-users-template.xlsx');
  }

  const importMut = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: number; errors: { row: number; message: string }[] }>(
        `${base}/users/import`,
        { method: 'POST', body: JSON.stringify({ site_id: siteId, rows: validRows }) },
      ),
    onSuccess: (r) => {
      setResult(r);
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
      <DialogSurface style={{ maxWidth: 900, width: '94vw' }}>
        <DialogBody>
          <DialogTitle>Import users from a spreadsheet</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.summary}>
                <Button size="small" icon={<ArrowDownloadRegular />} onClick={downloadTemplate}>
                  Download template
                </Button>
                <Text className={s.muted}>
                  .xlsx or .csv · first row is the header · UPN and Phone number required.
                </Text>
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
                  <>Loaded <b>{fileName}</b> — click to choose another</>
                ) : (
                  <>Click to choose a file, or drop it here</>
                )}
              </div>

              {err && (
                <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Text>
              )}

              {result && (
                <Text>
                  Imported <b>{result.created}</b> · skipped <b>{result.skipped}</b> (UPN already
                  present){result.errors.length ? ` · ${result.errors.length} failed` : ''}.
                </Text>
              )}

              {parsed && !result && (
                <>
                  <div className={s.summary}>
                    <Badge appearance="tint" color="success">{counts.ok} ready</Badge>
                    {counts.warn > 0 && (
                      <Badge appearance="tint" color="warning">{counts.warn} with warnings</Badge>
                    )}
                    {counts.error > 0 && (
                      <Badge appearance="tint" color="danger">{counts.error} skipped (errors)</Badge>
                    )}
                  </div>
                  <div className={s.scroll}>
                    <DataTable size="small" minWidth={640}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>#</TableHeaderCell>
                          <TableHeaderCell>UPN</TableHeaderCell>
                          <TableHeaderCell>Number</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parsed.map((p) => (
                          <TableRow key={p.n}>
                            <TableCell>{p.n}</TableCell>
                            <TableCell>{p.row.upn ?? '—'}</TableCell>
                            <TableCell>{p.row.requested_number ?? '—'}</TableCell>
                            <TableCell>
                              <Badge
                                appearance="tint"
                                size="small"
                                color={p.status === 'ok' ? 'success' : p.status === 'warn' ? 'warning' : 'danger'}
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
                disabled={validRows.length === 0 || importMut.isPending}
                onClick={() => importMut.mutate()}
              >
                {importMut.isPending ? 'Importing…' : `Import ${validRows.length} valid row${validRows.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
