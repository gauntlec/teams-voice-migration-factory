import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, Dropdown, Field, Input, Option, Spinner, Switch, Tab, TabList, Text, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  ArrowDownloadRegular,
  DocumentPdfRegular,
  SparkleRegular,
  ArrowLeftRegular,
  CalendarClockRegular,
  ChevronRightRegular,
  DocumentTableRegular,
  HistoryRegular,
  PhoneRegular,
  BotRegular,
  ReceiptRegular,
  TaskListLtrRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import {
  REPORT_CATALOGUE,
  REPORT_GROUPS,
  REPORT_KEYS,
  REPORT_PERIOD_LABELS,
  REPORT_PERIOD_PRESETS,
  SR_TYPE_DEFS,
  buildAssistantReport,
  buildChangeLogReport,
  buildDeviceReport,
  buildExecutiveSummary,
  buildIncidentReport,
  buildMigrationReport,
  buildServiceRequestReport,
  previousReportPeriod,
  reportFileName,
  reportPeriodLabel,
  reportPeriodQuery,
  reportQueryPeriod,
  utcDay,
  type AssistantActivityData,
  type ChangeLogData,
  type CustomerMetrics,
  type DeviceStatusOverview,
  type IncidentReportData,
  type MetricHistoryPoint,
  type ReportDocument,
  type ReportKey,
  type ReportPeriod,
  type ServiceRequestReportData,
} from '@tvmf/shared';
import { api, apiDownload } from '../../api';
import { useAuth } from '../../auth';
import { Page } from '../../components/Page';
import { LoadError, NoTenant } from '../../components/records';
import { useNotify } from '../../hooks/useNotify';
import { exportReportCsv, exportReportExcel, hasTable } from '../../lib/exportReport';
import { reportAvailable } from './reportsShared';
import { ReportView } from './ReportView';
import { SchedulesPanel } from './Schedules';

/**
 * An emailed report link carries ?customer=<id>: switch to that customer when this person can open it, so the link shows
 * the report it was sent about.
 */
function useCustomerFromLink() {
  const [params] = useSearchParams();
  const { me, activeTenantId, setActiveTenant } = useAuth();
  const want = params.get('customer');
  useEffect(() => {
    if (want && want !== activeTenantId && me?.tenants.some((t) => t.id === want)) setActiveTenant(want);
  }, [want, activeTenantId, me, setActiveTenant]);
}

const useStyles = makeStyles({
  group: { display: 'grid', ...shorthands.gap('8px') },
  groupTitle: { fontSize: tokens.fontSizeBase200, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground3 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', ...shorthands.gap('12px') },
  card: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'start',
    ...shorthands.gap('12px'),
    ...shorthands.padding('14px'),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    textDecorationLine: 'none',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1Hover) },
  },
  icon: {
    width: '32px',
    height: '32px',
    display: 'grid',
    placeItems: 'center',
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontSize: '18px',
  },
  featured: { ...shorthands.borderColor(tokens.colorBrandStroke1), boxShadow: `inset 0 0 0 1px ${tokens.colorBrandStroke1}, ${tokens.shadow4}` },
  cardText: { display: 'grid', ...shorthands.gap('2px') },
  muted: { color: tokens.colorNeutralForeground3 },
  chev: { color: tokens.colorNeutralForeground3, alignSelf: 'center' },
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'end',
    ...shorthands.gap('10px', '16px'),
    ...shorthands.padding('12px', '14px'),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  spacer: { flexGrow: 1 },
  period: { minWidth: '190px' },
  date: { maxWidth: '170px' },
  head: { display: 'grid', ...shorthands.gap('2px') },
});

const ICONS: Record<ReportKey, JSX.Element> = {
  executive: <SparkleRegular />,
  migration: <TaskListLtrRegular />,
  changes: <HistoryRegular />,
  incidents: <WarningRegular />,
  'service-requests': <ReceiptRegular />,
  assistants: <BotRegular />,
  devices: <PhoneRegular />,
};

/** The Reports catalogue (docs/INSIGHTS.md, step 3): the reports this person can open for the active customer. */
export function Reports() {
  const s = useStyles();
  const { me, activeTenantId, can } = useAuth();
  const [params, setParams] = useSearchParams();
  useCustomerFromLink();
  const tenant = me?.tenants.find((t) => t.id === activeTenantId);
  if (!activeTenantId || !tenant) return <NoTenant />;
  const canSchedule = can('reports:schedule');
  const tab = canSchedule && params.get('tab') === 'scheduled' ? 'scheduled' : 'catalogue';
  const startWith = params.get('new');
  const chooseTab = (t: string) => setParams(t === 'scheduled' ? { tab: 'scheduled' } : {}, { replace: true });
  const open = REPORT_KEYS.filter((k) => reportAvailable(k, can, tenant));
  const groups = REPORT_GROUPS.map((g) => ({ g, keys: open.filter((k) => REPORT_CATALOGUE[k].group === g) })).filter((x) => x.keys.length || (x.g === 'Migration' && can('tenantdiscovery:read')));
  return (
    <Page title="Reports" subtitle="Choose a report, then the period. Each one compares with the period before, downloads as a PDF and exports to Excel or CSV.">
      {canSchedule && (
        <TabList selectedValue={tab} onTabSelect={(_, d) => chooseTab(String(d.value))}>
          <Tab value="catalogue">Reports</Tab>
          <Tab value="scheduled" icon={<CalendarClockRegular />}>
            Scheduled
          </Tab>
        </TabList>
      )}
      {tab === 'scheduled' ? (
        <SchedulesPanel tenantId={activeTenantId} tenant={tenant} can={can} startWith={(REPORT_KEYS as readonly string[]).includes(startWith ?? '') ? (startWith as ReportKey) : null} />
      ) : (
        <>
      {groups.map(({ g, keys }) => (
        <div key={g} className={s.group}>
          <span className={s.groupTitle}>{g}</span>
          <div className={s.grid}>
            {keys.map((k) => (
                <RouterLink key={k} to={`/reports/${k}${k === 'executive' ? '?period=last_month' : ''}`} className={mergeClasses(s.card, k === 'executive' && s.featured)} aria-label={`Open the ${REPORT_CATALOGUE[k].title} report`}>
                  <span className={s.icon}>{ICONS[k]}</span>
                  <span className={s.cardText}>
                    <Text weight="semibold">{REPORT_CATALOGUE[k].title}</Text>
                    <Text size={200} className={s.muted}>
                      {REPORT_CATALOGUE[k].description}
                    </Text>
                  </span>
                  <ChevronRightRegular className={s.chev} />
                </RouterLink>
            ))}
            {g === 'Migration' && can('tenantdiscovery:read') && (
                <RouterLink to="/discovery?tab=licences" className={s.card} aria-label="Open the licence report in Discovery">
                  <span className={s.icon}>
                    <DocumentTableRegular />
                  </span>
                  <span className={s.cardText}>
                    <Text weight="semibold">Licences and costs</Text>
                    <Text size={200} className={s.muted}>
                      Teams Phone and resource account licences assigned, unused or missing. Opens in Discovery, from the latest sync.
                    </Text>
                  </span>
                  <ChevronRightRegular className={s.chev} />
                </RouterLink>
            )}
          </div>
        </div>
      ))}
        </>
      )}
    </Page>
  );
}

/** ?period=last_month, or ?from=&to= for custom dates; ?compare=0 turns the comparison off (reportQueryPeriod, shared with the api's PDFs). */
function usePeriod() {
  const [params, setParams] = useSearchParams();
  const today = utcDay();
  const { period, preset: choice } = reportQueryPeriod({ period: params.get('period'), from: params.get('from'), to: params.get('to') }, today);
  const compare = params.get('compare') !== '0';
  const set = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v === null ? p.delete(k) : p.set(k, v);
    setParams(p, { replace: true });
  };
  return { choice, period, compare, today, set, query: params.toString() };
}

/** One report: its period, the comparison, the exports, and the report itself. */
export function ReportPage() {
  const s = useStyles();
  const { key } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const { me, activeTenantId, can } = useAuth();
  useCustomerFromLink();
  const tenant = me?.tenants.find((t) => t.id === activeTenantId);
  const { choice, period, compare, today, set, query } = usePeriod();
  const reportKey = (REPORT_KEYS as readonly string[]).includes(key ?? '') ? (key as ReportKey) : null;
  const usable = !!reportKey && !!tenant && reportAvailable(reportKey, can, tenant);
  const doc = useReport(usable ? reportKey : null, activeTenantId ?? '', period, compare, today);

  if (!activeTenantId || !tenant) return <NoTenant />;
  if (!reportKey || !usable) {
    return (
      <Page title="Report not available" narrow>
        <Text>This report isn’t available for this customer, or for your role.</Text>
        <Button icon={<ArrowLeftRegular />} onClick={() => navigate('/reports')}>
          All reports
        </Button>
      </Page>
    );
  }
  const meta = REPORT_CATALOGUE[reportKey];
  const exportAs = async (kind: 'pdf' | 'excel' | 'csv') => {
    if (!doc.data) return;
    try {
      // The PDF is made by the api from the same report sections, so it matches the page.
      if (kind === 'pdf') await apiDownload(`/t/${activeTenantId}/insights/reports/${reportKey}/pdf${query ? `?${query}` : ''}`, `${reportFileName(doc.data, tenant.name)}.pdf`);
      else if (kind === 'excel') await exportReportExcel(doc.data, tenant.name);
      else exportReportCsv(doc.data, tenant.name);
    } catch (e) {
      notify('The export did not work', { intent: 'error', body: (e as Error).message });
    }
  };

  return (
    <Page
      title={meta.title}
      subtitle={doc.data ? `${reportPeriodLabel(doc.data.period)}${doc.data.comparedWith ? `, compared with ${reportPeriodLabel(doc.data.comparedWith)}` : ''} · ${doc.data.summary}` : meta.description}
      actions={
        <RouterLink to="/reports">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All reports
          </Button>
        </RouterLink>
      }
    >
      <div className={s.bar}>
        {meta.period && (
          <>
            <Field label="Period" className={s.period}>
              <Dropdown
                value={REPORT_PERIOD_LABELS[choice]}
                selectedOptions={[choice]}
                onOptionSelect={(_, d) =>
                  d.optionValue === 'custom'
                    ? set({ period: null, from: period.from, to: period.to })
                    : set({ period: d.optionValue ?? null, from: null, to: null })
                }
              >
                {[...REPORT_PERIOD_PRESETS, 'custom' as const].map((p) => (
                  <Option key={p} value={p}>
                    {REPORT_PERIOD_LABELS[p]}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            {choice === 'custom' && (
              <>
                <Field label="From">
                  <Input className={s.date} type="date" value={period.from} max={period.to} onChange={(_, d) => d.value && set({ from: d.value })} />
                </Field>
                <Field label="To">
                  <Input className={s.date} type="date" value={period.to} min={period.from} max={today} onChange={(_, d) => d.value && set({ to: d.value })} />
                </Field>
              </>
            )}
            {(reportKey === 'incidents' || reportKey === 'service-requests') && (
              <Switch label="Compare with the period before" checked={compare} onChange={(_, d) => set({ compare: d.checked ? null : '0' })} />
            )}
          </>
        )}
        <span className={s.spacer} />
        <Button appearance="primary" icon={<DocumentPdfRegular />} disabled={!doc.data} onClick={() => void exportAs('pdf')}>
          Download PDF
        </Button>
        <Button icon={<ArrowDownloadRegular />} disabled={!doc.data} onClick={() => void exportAs('excel')}>
          Excel
        </Button>
        {can('reports:schedule') && (
          <Button appearance="subtle" icon={<CalendarClockRegular />} onClick={() => navigate(`/reports?tab=scheduled&new=${reportKey}`)}>
            Schedule
          </Button>
        )}
        {doc.data && hasTable(doc.data) && (
          <Button appearance="subtle" disabled={!doc.data} onClick={() => void exportAs('csv')}>
            CSV
          </Button>
        )}
      </div>
      {doc.isLoading ? <Spinner label="Working out the report…" /> : doc.error ? <LoadError message={doc.error.message} /> : doc.data ? <ReportView doc={doc.data} /> : null}
    </Page>
  );
}

/** Fetches what a report needs (and the previous period, when comparing) and builds its document. */
function useReport(key: ReportKey | null, tenantId: string, period: ReportPeriod, compare: boolean, today: string): { data?: ReportDocument; isLoading: boolean; error: Error | null } {
  const prevPeriod = useMemo(() => previousReportPeriod(period), [period]);
  const iso = reportPeriodQuery(period);
  const prevIso = reportPeriodQuery(prevPeriod);
  const t = `/t/${tenantId}`;
  const enabled = (k: ReportKey) => key === k;
  const qs = (q: { from: string; to: string }) => `from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`;

  const metrics = useQuery({ queryKey: ['insights', tenantId, 'metrics'], enabled: enabled('migration'), queryFn: () => api<CustomerMetrics>(`${t}/insights/metrics`) });
  const execNow = useQuery({
    queryKey: ['insights', tenantId, 'metrics', period.from, period.to],
    enabled: enabled('executive'),
    queryFn: () => api<CustomerMetrics>(`${t}/insights/metrics?from=${period.from}&to=${period.to}`),
  });
  const execBefore = useQuery({
    queryKey: ['insights', tenantId, 'metrics', prevPeriod.from, prevPeriod.to],
    enabled: enabled('executive'),
    queryFn: () => api<CustomerMetrics>(`${t}/insights/metrics?from=${prevPeriod.from}&to=${prevPeriod.to}`),
  });
  const execHistory = useQuery({
    queryKey: ['insights', tenantId, 'history', prevPeriod.from, period.to],
    enabled: enabled('executive'),
    queryFn: () => api<MetricHistoryPoint[]>(`${t}/insights/history?from=${prevPeriod.from}&to=${period.to}`),
  });
  const history = useQuery({
    queryKey: ['insights', tenantId, 'history', period.from, period.to],
    enabled: enabled('migration'),
    queryFn: () => api<MetricHistoryPoint[]>(`${t}/insights/history?from=${period.from}&to=${period.to}`),
  });
  const inc = useQuery({ queryKey: ['report', 'incidents', tenantId, iso.from, iso.to], enabled: enabled('incidents'), queryFn: () => api<IncidentReportData>(`${t}/incidents/report?${qs(iso)}`) });
  const incPrev = useQuery({
    queryKey: ['report', 'incidents', tenantId, prevIso.from, prevIso.to],
    enabled: enabled('incidents') && compare,
    queryFn: () => api<IncidentReportData>(`${t}/incidents/report?${qs(prevIso)}`),
  });
  const sr = useQuery({ queryKey: ['report', 'sr', tenantId, iso.from, iso.to], enabled: enabled('service-requests'), queryFn: () => api<ServiceRequestReportData>(`${t}/service-requests/report?${qs(iso)}`) });
  const srPrev = useQuery({
    queryKey: ['report', 'sr', tenantId, prevIso.from, prevIso.to],
    enabled: enabled('service-requests') && compare,
    queryFn: () => api<ServiceRequestReportData>(`${t}/service-requests/report?${qs(prevIso)}`),
  });
  const assistants = useQuery({ queryKey: ['report', 'assistants', tenantId, period.from, period.to], enabled: enabled('assistants'), queryFn: () => api<AssistantActivityData>(`${t}/insights/assistants?from=${period.from}&to=${period.to}`) });
  const assistantsPrev = useQuery({
    queryKey: ['report', 'assistants', tenantId, prevPeriod.from, prevPeriod.to],
    enabled: enabled('assistants') && compare,
    queryFn: () => api<AssistantActivityData>(`${t}/insights/assistants?from=${prevPeriod.from}&to=${prevPeriod.to}`),
  });
  const changes = useQuery({ queryKey: ['report', 'changes', tenantId, period.from, period.to], enabled: enabled('changes'), queryFn: () => api<ChangeLogData>(`${t}/insights/changes?from=${period.from}&to=${period.to}`) });
  const devices = useQuery({ queryKey: ['report', 'devices', tenantId], enabled: enabled('devices'), queryFn: () => api<DeviceStatusOverview>(`${t}/device-status`) });

  const pick = (...qs2: { isLoading: boolean; error: unknown }[]) => ({ isLoading: qs2.some((q) => q.isLoading), error: (qs2.find((q) => q.error)?.error as Error | undefined) ?? null });
  switch (key) {
    case 'executive':
      return {
        ...pick(execNow, execBefore, execHistory),
        data: execNow.data && execBefore.data && execHistory.data ? buildExecutiveSummary({ metrics: execNow.data, previous: execBefore.data, history: execHistory.data, period, comparedWith: prevPeriod, today }) : undefined,
      };
    case 'migration':
      return { ...pick(metrics, history), data: metrics.data && history.data ? buildMigrationReport(metrics.data, history.data, period) : undefined };
    case 'incidents':
      return { ...pick(inc, ...(compare ? [incPrev] : [])), data: inc.data && (!compare || incPrev.data) ? buildIncidentReport(inc.data, compare ? (incPrev.data ?? null) : null, period, prevPeriod) : undefined };
    case 'service-requests':
      return {
        ...pick(sr, ...(compare ? [srPrev] : [])),
        data: sr.data && (!compare || srPrev.data) ? buildServiceRequestReport(sr.data, compare ? (srPrev.data ?? null) : null, period, (x) => SR_TYPE_DEFS[x].label, prevPeriod) : undefined,
      };
    case 'assistants':
      return {
        ...pick(assistants, ...(compare ? [assistantsPrev] : [])),
        data: assistants.data && (!compare || assistantsPrev.data) ? buildAssistantReport(assistants.data, compare ? (assistantsPrev.data ?? null) : null, period, prevPeriod) : undefined,
      };
    case 'changes':
      return { ...pick(changes), data: changes.data ? buildChangeLogReport(changes.data, period) : undefined };
    case 'devices':
      return { ...pick(devices), data: devices.data ? buildDeviceReport(devices.data.devices, today) : undefined };
    default:
      return { isLoading: false, error: null };
  }
}
