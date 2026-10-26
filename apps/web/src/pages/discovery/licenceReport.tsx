import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { LicenceFinding } from '@tvmf/shared';
import { api } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';

const useStyles = makeStyles({
  list: { display: 'grid', rowGap: '12px' },
  card: { display: 'grid', rowGap: '8px', padding: '16px' },
  head: { display: 'flex', alignItems: 'center', columnGap: '10px', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  sites: { display: 'flex', flexWrap: 'wrap', columnGap: '6px', rowGap: '4px' },
});

const SEVERITY: Record<LicenceFinding['severity'], { label: string; color: 'warning' | 'danger' | 'informative' }> = {
  cost: { label: 'Paid for, not used', color: 'warning' },
  broken: { label: 'Will not work', color: 'danger' },
  tidy: { label: 'Tidy up', color: 'informative' },
};

/** Discovery > Licences & costs: what is paid for but unused, from the last sync (shared/licence-report.ts). Counts only, no prices. */
export function LicenceReport({ base }: { base: string }) {
  const s = useStyles();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['tdisc', 'licence-report', base], queryFn: () => api<{ findings: LicenceFinding[]; dataAsOf: string | null }>(`${base}/licence-report`) });

  const exportExcel = async () => {
    if (!q.data) return;
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(q.data.findings.map((f) => ({ Finding: f.title, Count: f.items.length, Why: f.why, 'What to do': f.action }))),
      'Summary',
    );
    for (const f of q.data.findings) {
      if (!f.items.length) continue;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(f.items.map((i) => ({ Name: i.name, UPN: i.upn ?? '', Site: i.site ?? '', Detail: i.detail }))), f.key.slice(0, 31));
    }
    XLSX.writeFile(wb, 'voxshift-licence-report.xlsx');
  };

  if (q.isLoading) return <Spinner size="tiny" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  const data = q.data!;
  const stale = !data.dataAsOf || Date.now() - Date.parse(data.dataAsOf) > 7 * 86400_000;

  return (
    <div className={s.list}>
      <div className={s.head}>
        <Text size={200} className={s.muted}>
          {data.dataAsOf ? `From the Discovery sync of ${new Date(data.dataAsOf).toLocaleString()}.` : 'No completed Discovery sync yet.'}
          {stale && ' Run a sync for an up-to-date answer.'} Counts only - Voxshift does not hold prices.
        </Text>
        <Button size="small" onClick={exportExcel} disabled={data.findings.every((f) => f.items.length === 0)}>
          Download Excel
        </Button>
      </div>
      {data.findings.map((f) => (
        <Card key={f.key} className={s.card}>
          <div className={s.head}>
            <Text weight="semibold" size={400}>
              {f.items.length}
            </Text>
            <Text weight="semibold">{f.title}</Text>
            <Badge appearance="tint" color={SEVERITY[f.severity].color}>
              {SEVERITY[f.severity].label}
            </Badge>
          </div>
          <Text size={200}>
            {f.why} <span className={s.muted}>{f.action}</span>
          </Text>
          {f.items.length > 0 && (
            <>
              <div className={s.sites}>
                {f.bySite.map((b) => (
                  <Badge key={b.site} appearance="outline" size="small">
                    {b.site} {b.count}
                  </Badge>
                ))}
              </div>
              <div>
                <Button size="small" appearance="subtle" onClick={() => setOpen(open === f.key ? null : f.key)}>
                  {open === f.key ? 'Hide the list' : `Show all ${f.items.length}`}
                </Button>
              </div>
              {open === f.key && (
                <DataTable size="small" minWidth={600}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>UPN</TableHeaderCell>
                      <TableHeaderCell>Site</TableHeaderCell>
                      <TableHeaderCell>Detail</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {f.items.map((i) => (
                      <TableRow key={`${i.name}-${i.upn ?? ''}`}>
                        <TableCell>{i.name}</TableCell>
                        <TableCell>{i.upn ?? '—'}</TableCell>
                        <TableCell>{i.site ?? '—'}</TableCell>
                        <TableCell>{i.detail}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTable>
              )}
            </>
          )}
        </Card>
      ))}
    </div>
  );
}
