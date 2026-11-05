import { useQuery } from '@tanstack/react-query';
import { Badge, Button, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowDownloadRegular, ChevronRightRegular, DocumentPdfRegular } from '@fluentui/react-icons';
import {
  buildPortfolioReport,
  goLiveDateLabel,
  portfolioTotals,
  sortPortfolio,
  utcDay,
  type PortfolioData,
  type PortfolioRow,
} from '@tvmf/shared';
import { api, apiDownload } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { EmptyState, TableSkeleton } from '../../components/states';
import { useNotify } from '../../hooks/useNotify';
import { exportReportExcel } from '../../lib/exportReport';

const useStyles = makeStyles({
  root: { display: 'grid', ...shorthands.gap('16px'), minWidth: 0 },
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap('8px') },
  actions: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('8px') },
  kpis: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('12px') },
  kpi: {
    display: 'grid',
    ...shorthands.gap('2px'),
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '170px',
    ...shorthands.padding('12px', '14px'),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  label: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  of: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightRegular, color: tokens.colorNeutralForeground3, letterSpacing: '0' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  up: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200 },
  row: { cursor: 'pointer' },
  name: { display: 'grid' },
  prog: { display: 'grid', gridTemplateColumns: '90px auto', alignItems: 'center', ...shorthands.gap('8px') },
  track: { height: '6px', ...shorthands.borderRadius('3px'), backgroundColor: tokens.colorNeutralBackground3, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: tokens.colorCompoundBrandBackground },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
});

const STATUS: Record<string, { label: string; color: 'success' | 'warning' | 'danger' | 'informative' | 'brand' }> = {
  off_track: { label: 'Off track', color: 'danger' },
  at_risk: { label: 'At risk', color: 'warning' },
  on_track: { label: 'On track', color: 'success' },
  no_date: { label: 'No go-live dates', color: 'informative' },
  complete: { label: 'All sites live', color: 'brand' },
  no_sites: { label: 'No sites yet', color: 'informative' },
};

function statusOf(r: PortfolioRow) {
  if (r.error) return { label: 'Figures unavailable', color: 'danger' as const };
  if (r.incidents?.openP1) return { label: `P1 open (${r.incidents.openP1})`, color: 'danger' as const };
  if (r.mode === 'operations' && r.status === 'complete') return { label: 'In service', color: 'brand' as const };
  return STATUS[r.status] ?? STATUS.no_sites!;
}

export const usePortfolio = () => useQuery({ queryKey: ['insights', 'portfolio'], queryFn: () => api<PortfolioData>('/insights/portfolio'), refetchInterval: 120_000 });

/**
 * MSP › Customer reporting (docs/INSIGHTS.md, step 5): every customer the person can open, worst first, with the figures
 * from each customer's Overview. Selecting a customer opens its Overview.
 */
/** `presenting`: drawn as a Present mode slide - no buttons, and rows don't open anything. */
export function AllCustomers({ onOpen, presenting = false }: { onOpen: (tenantId: string) => void; presenting?: boolean }) {
  const s = useStyles();
  const notify = useNotify();
  const q = usePortfolio();
  if (q.isLoading) return <TableSkeleton rows={5} cols={7} label="Loading every customer" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;
  const rows = sortPortfolio(q.data!.rows);
  if (!rows.length) return <EmptyState title="No customers yet" hint="Customers you are a member of appear here." />;
  const t = portfolioTotals(rows);
  const fmt = (n: number) => n.toLocaleString('en-GB');
  const exportAs = async (kind: 'pdf' | 'excel') => {
    try {
      if (kind === 'pdf') await apiDownload('/insights/portfolio/pdf', `voxshift-portfolio-all-customers-${utcDay()}.pdf`);
      else await exportReportExcel(buildPortfolioReport(q.data!, utcDay()), 'All customers');
    } catch (e) {
      notify('The export did not work', { intent: 'error', body: (e as Error).message });
    }
  };

  return (
    <div className={s.root}>
      {!presenting && <div className={s.bar}>
        <Text className={s.muted}>
          {rows.length} {rows.length === 1 ? 'customer' : 'customers'} · as at {new Date(q.data!.asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Worst first;
          select a customer to open its Overview.
        </Text>
        <div className={s.actions}>
          <Button appearance="primary" icon={<DocumentPdfRegular />} onClick={() => void exportAs('pdf')}>
            Portfolio report
          </Button>
          <Button icon={<ArrowDownloadRegular />} onClick={() => void exportAs('excel')}>
            Excel
          </Button>
        </div>
      </div>}
      <div className={s.kpis}>
        <div className={s.kpi}>
          <span className={s.label}>Users on Teams Phone</span>
          <span className={s.value}>
            {fmt(t.usersLive)} <span className={s.of}>/ {fmt(t.users)}</span>
          </span>
          {t.usersLive30dAgo !== null && t.usersLive > t.usersLive30dAgo && <span className={s.up}>▲ {fmt(t.usersLive - t.usersLive30dAgo)} in 30 days</span>}
        </div>
        <div className={s.kpi}>
          <span className={s.label}>Sites live</span>
          <span className={s.value}>
            {fmt(t.sitesLive)} <span className={s.of}>/ {fmt(t.sites)}</span>
          </span>
        </div>
        <div className={s.kpi}>
          <span className={s.label}>Incident targets met, 30 days</span>
          <span className={s.value}>{t.targetsMetPct === null ? '–' : `${t.targetsMetPct}%`}</span>
        </div>
        <div className={s.kpi}>
          <span className={s.label}>Open P1 / P2</span>
          <span className={s.value}>
            {t.openP1} <span className={s.of}>/ {t.openP2}</span>
          </span>
        </div>
        <div className={s.kpi}>
          <span className={s.label}>Customers needing attention</span>
          <span className={s.value}>
            {t.needAttention} <span className={s.of}>/ {t.customers}</span>
          </span>
        </div>
      </div>
      <DataTable minWidth={900}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Customer</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Sites live</TableHeaderCell>
            <TableHeaderCell className={s.num}>Users live</TableHeaderCell>
            <TableHeaderCell className={s.num}>Targets met</TableHeaderCell>
            <TableHeaderCell className={s.num}>Open P1 / P2</TableHeaderCell>
            <TableHeaderCell>Next go-live</TableHeaderCell>
            <TableHeaderCell />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const st = statusOf(r);
            const pct = r.sites ? Math.round((r.sitesLive / r.sites) * 100) : 0;
            return (
              <TableRow
                key={r.tenantId}
                className={presenting ? undefined : s.row}
                {...(presenting
                  ? {}
                  : {
                      tabIndex: 0,
                      'aria-label': `Open ${r.name}`,
                      onClick: () => onOpen(r.tenantId),
                      onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(r.tenantId)),
                    })}
              >
                <TableCell>
                  <span className={s.name}>
                    <Text weight="semibold">{r.name}</Text>
                    <span className={s.muted}>
                      {r.mode === 'operations' ? 'Operations' : 'Migration'}
                      {r.mspName ? ` · ${r.mspName}` : ''}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <Badge appearance="tint" color={st.color}>
                    {st.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className={s.prog}>
                    <span className={s.track} aria-hidden="true">
                      <span className={s.fill} style={{ width: `${pct}%`, display: 'block' }} />
                    </span>
                    <span>
                      {r.sitesLive} / {r.sites}
                    </span>
                  </span>
                </TableCell>
                <TableCell className={s.num}>{fmt(r.usersLive)}</TableCell>
                <TableCell className={s.num}>{r.incidents?.targetsMetPct === null || !r.incidents ? '—' : `${r.incidents.targetsMetPct}%`}</TableCell>
                <TableCell className={s.num}>{r.incidents ? `${r.incidents.openP1} / ${r.incidents.openP2}` : '—'}</TableCell>
                <TableCell>{r.nextGoLive ? `${r.nextGoLive.sitecode}, ${goLiveDateLabel(r.nextGoLive.date)}` : <span className={s.muted}>—</span>}</TableCell>
                <TableCell>{!presenting && <ChevronRightRegular />}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>
    </div>
  );
}
