import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router';
import { Badge, Card, Skeleton, SkeletonItem, Text, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { ArrowRightRegular, CalendarLtrRegular, CheckmarkCircleRegular, ErrorCircleRegular, WarningRegular } from '@fluentui/react-icons';
import { LineChart, ResponsiveContainer, type LineChartPoints } from '@fluentui/react-charts';
import {
  CUSTOMER_GO_LIVE_STATUS_LABELS,
  GO_LIVE_STATUS_LABELS,
  PROGRESS_STAGE_LABELS,
  PROGRESS_STAGES,
  goLiveDateLabel,
  goLivePlan,
  overviewHeadline,
  utcDay,
  type CustomerGoLiveStatus,
  type CustomerMetrics,
  type GoLiveStatus,
  type MetricHistoryPoint,
  type Permission,
  type ProgressStageViewKey,
  type SiteMetrics,
} from '@tvmf/shared';
import { api } from '../../api';
import { LoadError } from '../../components/records';

const DAY_MS = 86_400_000;
const fmt = (n: number) => n.toLocaleString('en-GB');
const dayOffset = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const useStyles = makeStyles({
  root: { display: 'grid', ...shorthands.gap('16px'), minWidth: 0 },
  hero: {
    position: 'relative',
    overflow: 'hidden',
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    ...shorthands.gap('24px'),
    ...shorthands.padding('22px', '26px'),
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackgroundPressed} 0%, ${tokens.colorBrandBackgroundSelected} 55%, ${tokens.colorBrandBackground} 100%)`,
    '@media (max-width: 720px)': { gridTemplateColumns: '1fr', justifyItems: 'start', ...shorthands.gap('14px') },
  },
  heroBars: { position: 'absolute', right: '18px', bottom: '-8px', opacity: 0.13, pointerEvents: 'none' },
  heroText: { position: 'relative', display: 'grid', ...shorthands.gap('4px'), minWidth: 0 },
  heroEyebrow: { fontSize: tokens.fontSizeBase200, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.82 },
  heroTitle: { fontSize: tokens.fontSizeBase600, lineHeight: tokens.lineHeightBase600, fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.015em', textWrap: 'balance' },
  heroBody: { fontSize: tokens.fontSizeBase300, opacity: 0.9, maxWidth: '70ch', display: 'grid', ...shorthands.gap('2px') },
  heroSide: { position: 'relative', display: 'grid', justifyItems: 'end', ...shorthands.gap('6px'), fontSize: tokens.fontSizeBase200, textAlign: 'right', '@media (max-width: 720px)': { justifyItems: 'start', textAlign: 'left' } },
  heroPill: {
    display: 'inline-flex',
    alignItems: 'center',
    ...shorthands.gap('6px'),
    ...shorthands.padding('2px', '10px'),
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    backgroundColor: 'rgba(255,255,255,0.16)',
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: 'nowrap',
  },
  dot: { width: '8px', height: '8px', ...shorthands.borderRadius('50%'), flexShrink: 0 },
  faint: { opacity: 0.82 },

  // Flex rather than a grid, so a last row with fewer tiles stretches instead of leaving one tile on its own.
  kpis: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('12px') },
  kpi: {
    display: 'grid',
    alignContent: 'start',
    ...shorthands.gap('2px'),
    ...shorthands.padding('12px', '14px', '10px'),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textDecorationLine: 'none',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '170px',
  },
  kpiLink: { ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1Hover) } },
  kpiLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  kpiValue: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  kpiOf: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightRegular, color: tokens.colorNeutralForeground3, letterSpacing: '0' },
  kpiFoot: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', ...shorthands.gap('2px', '8px'), fontSize: tokens.fontSizeBase200 },
  up: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  down: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3 },
  spark: { display: 'block', width: '100%', height: '28px', marginTop: '4px' },

  two: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', ...shorthands.gap('12px'), '@media (max-width: 1000px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  card: { display: 'grid', alignContent: 'start', ...shorthands.gap('10px'), minWidth: 0 },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', ...shorthands.gap('4px', '8px') },
  cardTitle: { fontWeight: tokens.fontWeightSemibold },
  legend: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('4px', '14px'), fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  swatch: { display: 'inline-block', width: '14px', height: '3px', ...shorthands.borderRadius('2px'), verticalAlign: 'middle', marginRight: '6px' },

  stageBar: { display: 'flex', height: '14px', ...shorthands.gap('2px'), ...shorthands.borderRadius(tokens.borderRadiusMedium), overflow: 'hidden' },
  stageKey: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', ...shorthands.gap('8px'), fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  stageCount: { display: 'block', fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, fontVariantNumeric: 'tabular-nums' },
  stageSwatch: { display: 'inline-block', width: '8px', height: '8px', ...shorthands.borderRadius('2px'), marginRight: '6px', verticalAlign: 'middle' },

  tl: { display: 'grid', ...shorthands.gap('8px'), fontSize: tokens.fontSizeBase200 },
  tlRow: { display: 'grid', gridTemplateColumns: 'minmax(96px, 150px) minmax(0, 1fr) auto', alignItems: 'center', ...shorthands.gap('10px') },
  tlName: { minWidth: 0, overflowX: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tlTrack: { position: 'relative', height: '16px', backgroundColor: tokens.colorNeutralBackground3, ...shorthands.borderRadius(tokens.borderRadiusMedium) },
  tlBar: { position: 'absolute', top: '4px', height: '8px', ...shorthands.borderRadius(tokens.borderRadiusCircular), minWidth: '8px' },
  tlDate: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  link: { color: tokens.colorBrandForegroundLink, textDecorationLine: 'none', ':hover': { textDecorationLine: 'underline' } },

  health: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('12px'), alignContent: 'start' },
  healthCard: { flexGrow: 1, flexShrink: 1, flexBasis: '200px' },
  chip: { justifySelf: 'start' },
  healthRow: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'center', ...shorthands.gap('12px') },
  big: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.015em', fontVariantNumeric: 'tabular-nums' },
  ring: { display: 'block', flexShrink: 0 },

  list: { display: 'grid', ...shorthands.gap('10px'), ...shorthands.margin(0), ...shorthands.padding(0), listStyleType: 'none' },
  decision: { display: 'grid', gridTemplateColumns: '4px minmax(0, 1fr) auto', ...shorthands.gap('10px'), alignItems: 'start' },
  stripe: { alignSelf: 'stretch', ...shorthands.borderRadius('2px') },
  skHero: { height: '150px', ...shorthands.borderRadius(tokens.borderRadiusXLarge) },
  skTile: { height: '104px' },
  skCard: { height: '300px' },
  okLine: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), color: tokens.colorNeutralForeground3 },
});

/** Semantic colours for a go-live status (not the brand accent). */
const STATUS_COLOR: Record<GoLiveStatus | CustomerGoLiveStatus, string> = {
  live: tokens.colorCompoundBrandBackground,
  complete: tokens.colorPaletteGreenBackground3,
  on_track: tokens.colorPaletteGreenBackground3,
  at_risk: tokens.colorPaletteMarigoldBackground3,
  off_track: tokens.colorPaletteRedBackground3,
  no_date: tokens.colorNeutralStroke1,
  no_sites: tokens.colorNeutralStroke1,
};
const STATUS_BADGE: Record<GoLiveStatus, 'success' | 'warning' | 'danger' | 'informative' | 'brand'> = {
  live: 'brand',
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'danger',
  no_date: 'informative',
};

/** Stages in the order a site moves through them, as the caller sees them. */
const stageOrder = (full: boolean): ProgressStageViewKey[] =>
  full ? [...PROGRESS_STAGES] : ['data_collection', 'delivery', 'handover', 'operations'];

/**
 * The Overview home page (docs/INSIGHTS.md, step 2): the answer to "are we on track?" for the active customer, built
 * entirely from GET /insights/metrics and /insights/history. Every number opens the page behind it where the user can.
 */
export function Overview({ tenantId, can }: { tenantId: string; can: (p: Permission) => boolean }) {
  const s = useStyles();
  const today = utcDay();
  const metrics = useQuery({
    queryKey: ['insights', tenantId, 'metrics'],
    queryFn: () => api<CustomerMetrics>(`/t/${tenantId}/insights/metrics`),
    refetchInterval: 60_000,
  });
  // The 30 days before, to compare the period figures with.
  const previous = useQuery({
    queryKey: ['insights', tenantId, 'metrics', 'previous'],
    queryFn: () => api<CustomerMetrics>(`/t/${tenantId}/insights/metrics?from=${dayOffset(today, -59)}&to=${dayOffset(today, -30)}`),
    staleTime: 10 * 60_000,
  });
  const history = useQuery({
    queryKey: ['insights', tenantId, 'history'],
    queryFn: () => api<MetricHistoryPoint[]>(`/t/${tenantId}/insights/history`),
    staleTime: 10 * 60_000,
  });

  if (metrics.isLoading) return <OverviewSkeleton />;
  if (metrics.isError) return <LoadError message={(metrics.error as Error).message} />;
  const m = metrics.data!;
  const points = history.data ?? [];
  return (
    <div className={s.root}>
      <Hero m={m} />
      <Kpis m={m} prev={previous.data} history={points} can={can} />
      <div className={s.two}>
        <UsersAgainstPlan m={m} history={points} today={today} />
        <Card className={s.card}>
          <SitesByStage m={m} />
          <Upcoming m={m} today={today} can={can} />
        </Card>
      </div>
      <div className={s.two}>
        <ServiceHealth m={m} />
        <Decisions m={m} can={can} />
      </div>
    </div>
  );
}

/* ------------------------------ brand panel ------------------------------ */

function Hero({ m }: { m: CustomerMetrics }) {
  const s = useStyles();
  const h = overviewHeadline(m);
  const g = m.migration;
  const share = pctOf(g.usersLive, g.users);
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <section className={s.hero} aria-label="Migration summary">
      <svg className={s.heroBars} width="240" height="140" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="1" y="14" width="4.5" height="14" rx="2.25" fill="currentColor" />
        <rect x="7.5" y="10" width="4.5" height="18" rx="2.25" fill="currentColor" />
        <rect x="14" y="6" width="4.5" height="22" rx="2.25" fill="currentColor" />
        <rect x="21.5" y="1" width="4.5" height="16" rx="2.25" fill="currentColor" />
      </svg>
      <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={`${share}% of users are live on Teams Phone`}>
        <circle cx="56" cy="56" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="10" />
        <circle
          cx="56"
          cy="56"
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.92)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c.toFixed(2)}
          strokeDashoffset={(c * (1 - share / 100)).toFixed(2)}
          transform="rotate(-90 56 56)"
        />
        <text x="56" y="57" textAnchor="middle" fill="currentColor" fontSize="24" fontWeight="600">
          {share}%
        </text>
        <text x="56" y="74" textAnchor="middle" fill="currentColor" opacity="0.78" fontSize="10.5">
          users live
        </text>
      </svg>
      <div className={s.heroText}>
        <span className={s.heroEyebrow}>Teams Phone migration</span>
        <span className={s.heroTitle}>{h.title}</span>
        <div className={s.heroBody}>
          {h.sentences.map((x) => (
            <span key={x}>{x}</span>
          ))}
        </div>
      </div>
      <div className={s.heroSide}>
        <span className={s.heroPill}>
          <span className={s.dot} style={{ backgroundColor: STATUS_COLOR[g.status] }} />
          {CUSTOMER_GO_LIVE_STATUS_LABELS[g.status]}
        </span>
        {g.programmeEnd && <span className={s.faint}>Last go-live {goLiveDateLabel(g.programmeEnd)}</span>}
        <span className={s.faint}>
          As at {new Date(m.asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </section>
  );
}

/* ------------------------------ headline figures ------------------------------ */

interface Tile {
  key: string;
  label: string;
  value: string;
  of?: string;
  delta?: { text: string; good: boolean | null };
  note?: string;
  spark?: number[];
  to?: string | null;
}

/** The change since the history point closest to 30 days ago; null without history that far back. */
function changeOver30(history: MetricHistoryPoint[], today: string, pick: (p: MetricHistoryPoint) => number | undefined, now: number) {
  const target = dayOffset(today, -30);
  const base = history.find((p) => p.day >= target) ?? null;
  if (!base || base.day === today) return null;
  const v = pick(base);
  return v === undefined ? null : now - v;
}

function Kpis({ m, prev, history, can }: { m: CustomerMetrics; prev?: CustomerMetrics; history: MetricHistoryPoint[]; can: (p: Permission) => boolean }) {
  const s = useStyles();
  const today = utcDay();
  const g = m.migration;
  const deliveryLink = can('deployment:read') ? '/deployment' : can('discovery:read') ? '/data-collection' : null;
  const tiles: Tile[] = [];
  const signed = (n: number) => `${n > 0 ? '▲' : n < 0 ? '▼' : ''} ${fmt(Math.abs(n))}`.trim();

  const usersChange = changeOver30(history, today, (p) => p.usersLive, g.usersLive);
  tiles.push({
    key: 'users',
    label: 'Users live',
    value: fmt(g.usersLive),
    of: `/ ${fmt(g.users)}`,
    delta: usersChange === null ? undefined : usersChange === 0 ? { text: 'No change in 30 days', good: null } : { text: `${signed(usersChange)} in 30 days`, good: usersChange > 0 },
    note: usersChange === null ? `${pctOf(g.usersLive, g.users)}% of users` : undefined,
    spark: history.map((p) => p.usersLive).concat(g.usersLive),
    to: deliveryLink,
  });
  tiles.push({
    key: 'numbers',
    label: 'Numbers live',
    value: fmt(g.numbersLive),
    of: `/ ${fmt(g.numbers)}`,
    note: g.ports.requests ? `${g.ports.complete} of ${g.ports.requests} ports complete` : `${pctOf(g.numbersLive, g.numbers)}% of numbers`,
    spark: history.map((p) => p.numbersLive).concat(g.numbersLive),
    to: can('discovery:read') ? '/data-collection' : null,
  });
  if (m.incidents) {
    const now = m.incidents.targetsMetPct;
    const before = prev?.incidents?.targetsMetPct ?? null;
    tiles.push({
      key: 'targets',
      label: 'Incident targets met',
      value: now === null ? '–' : `${now}%`,
      delta:
        now !== null && before !== null
          ? now === before
            ? { text: 'No change', good: null }
            : { text: `${now > before ? '▲' : '▼'} ${Math.abs(Math.round((now - before) * 10) / 10)} pts`, good: now > before }
          : undefined,
      note: now === null ? 'None measured in 30 days' : `${m.incidents.targetsMeasured} targets in 30 days`,
      to: '/incidents',
    });
    tiles.push({
      key: 'open',
      label: 'Open incidents',
      value: fmt(m.incidents.open),
      note: `P1 ${m.incidents.openP1} · P2 ${m.incidents.openP2}`,
      spark: history.filter((p) => p.openIncidents !== undefined).map((p) => p.openIncidents!).concat(m.incidents.open),
      to: '/incidents',
    });
  } else {
    tiles.push({ key: 'sites', label: 'Sites live', value: fmt(g.sitesLive), of: `/ ${fmt(g.sites)}`, note: `${g.sitesInService} in service`, spark: history.map((p) => p.sitesLive).concat(g.sitesLive), to: can('discovery:read') ? '/data-collection' : null });
    if (m.serviceRequests) tiles.push({ key: 'sr', label: 'Open service requests', value: fmt(m.serviceRequests.open), note: `${m.serviceRequests.completed} completed in 30 days`, to: '/service-requests' });
  }
  const ch = m.changes;
  tiles.push({
    key: 'changes',
    label: 'Changes applied first time',
    value: ch.firstTimePct === null ? '–' : `${ch.firstTimePct}%`,
    note: ch.applied + ch.failed === 0 ? 'No changes to Teams in 30 days' : `${fmt(ch.applied + ch.failed)} changes to Teams in 30 days`,
    to: can('deployment:read') ? '/deployment' : null,
  });

  return (
    <div className={s.kpis}>
      {tiles.map((t) => {
        const body = (
          <>
            <span className={s.kpiLabel}>{t.label}</span>
            <span className={s.kpiValue}>
              {t.value} {t.of && <span className={s.kpiOf}>{t.of}</span>}
            </span>
            {t.spark && t.spark.length > 1 && <Spark values={t.spark} />}
            <span className={s.kpiFoot}>
              {t.delta && <span className={t.delta.good === null ? s.muted : t.delta.good ? s.up : s.down}>{t.delta.text}</span>}
              {t.note && <span className={s.muted}>{t.note}</span>}
            </span>
          </>
        );
        return t.to ? (
          <RouterLink key={t.key} to={t.to} className={mergeClasses(s.kpi, s.kpiLink)} aria-label={`${t.label}: ${t.value}${t.of ? ` ${t.of}` : ''}. Open`}>
            {body}
          </RouterLink>
        ) : (
          <div key={t.key} className={s.kpi}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** A small trend line: area fill, line, and the latest value marked. */
function Spark({ values }: { values: number[] }) {
  const s = useStyles();
  const w = 120;
  const h = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className={s.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${x(values.length - 1).toFixed(1)} ${h} L${x(0).toFixed(1)} ${h} Z`} style={{ fill: tokens.colorBrandBackground2 }} />
      <path d={line} fill="none" style={{ stroke: tokens.colorCompoundBrandStroke }} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r="2.6" style={{ fill: tokens.colorCompoundBrandStroke }} />
    </svg>
  );
}

/* ------------------------------ users against plan ------------------------------ */

function UsersAgainstPlan({ m, history, today }: { m: CustomerMetrics; history: MetricHistoryPoint[]; today: string }) {
  const s = useStyles();
  const g = m.migration;
  const data = useMemo(() => {
    const end = g.programmeEnd && g.programmeEnd > today ? dayOffset(g.programmeEnd, 7) : dayOffset(today, 14);
    // The plan runs from today: what should be live by each site's date. It only changes on a target date, so it is drawn as steps.
    const planDays = [...new Set([today, ...g.siteList.map((x) => x.targetGoLive).filter((d): d is string => !!d && d > today && d < end), end])].sort();
    const plan = goLivePlan(g.siteList, planDays);
    const actual = history.filter((p) => p.day < today).map((p) => ({ day: p.day, v: p.usersLive }));
    actual.push({ day: today, v: g.usersLive });
    const at = (d: string) => new Date(`${d}T00:00:00Z`);
    const lines: LineChartPoints[] = [
      {
        legend: 'Plan',
        color: tokens.colorNeutralStroke1Pressed,
        lineOptions: { strokeDasharray: '5 4', curve: 'stepAfter', strokeWidth: 1.5 },
        data: planDays.map((d, i) => ({ x: at(d), y: plan[i]! })),
      },
      { legend: 'Users live', color: tokens.colorCompoundBrandBackground, data: actual.map((p) => ({ x: at(p.day), y: p.v })) },
    ];
    return { lines, hasPlan: g.siteList.some((x) => x.targetGoLive), points: actual.length };
  }, [g, history, today]);

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <Text className={s.cardTitle}>Users live against plan</Text>
        <Text size={200} className={s.muted}>
          {g.users > 0 ? `${fmt(g.usersLive)} of ${fmt(g.users)} users` : 'No users yet'}
        </Text>
      </div>
      {g.users === 0 ? (
        <Text size={200} className={s.muted}>
          The chart appears once users are captured in Site Data or designed in Design &amp; Build.
        </Text>
      ) : (
        <>
          <ResponsiveContainer height={230}>
            <LineChart data={{ chartTitle: 'Users live against plan', lineChartData: data.lines }} hideLegend yMinValue={0} useUTC roundedTicks />
          </ResponsiveContainer>
          <div className={s.legend}>
            <span>
              <span className={s.swatch} style={{ backgroundColor: tokens.colorCompoundBrandBackground }} />
              Users live
            </span>
            <span>
              <span className={s.swatch} style={{ backgroundColor: tokens.colorNeutralStroke1Pressed }} />
              Plan from today, by each site’s go-live date
            </span>
          </div>
          {(!data.hasPlan || data.points < 3) && (
            <Text size={200} className={s.muted}>
              {!data.hasPlan ? 'Set go-live dates on the sites to draw the plan. ' : ''}
              {data.points < 3 ? 'Voxshift records these figures once a day, so the trend builds up from here.' : ''}
            </Text>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------ sites ------------------------------ */

function SitesByStage({ m }: { m: CustomerMetrics }) {
  const s = useStyles();
  const g = m.migration;
  const order = stageOrder(m.fullView);
  const shown = order.filter((k) => (g.sitesByStage[k] ?? 0) > 0);
  // A lighter shade for earlier stages, full brand colour for sites in service.
  const shade = (k: ProgressStageViewKey) => 0.3 + (0.7 * order.indexOf(k)) / Math.max(1, order.length - 1);
  return (
    <>
      <div className={s.cardHead}>
        <Text className={s.cardTitle}>Sites by stage</Text>
        <Text size={200} className={s.muted}>
          {g.sites} {g.sites === 1 ? 'site' : 'sites'}
        </Text>
      </div>
      {g.sites === 0 ? (
        <Text size={200} className={s.muted}>
          No sites yet.
        </Text>
      ) : (
        <>
          <div className={s.stageBar} role="img" aria-label={shown.map((k) => `${PROGRESS_STAGE_LABELS[k]} ${g.sitesByStage[k]}`).join(', ')}>
            {shown.map((k) => (
              <div key={k} style={{ flexGrow: g.sitesByStage[k], backgroundColor: tokens.colorCompoundBrandBackground, opacity: shade(k) }} />
            ))}
          </div>
          <div className={s.stageKey}>
            {shown.map((k) => (
              <span key={k}>
                <span className={s.stageCount}>{g.sitesByStage[k]}</span>
                <span className={s.stageSwatch} style={{ backgroundColor: tokens.colorCompoundBrandBackground, opacity: shade(k) }} />
                {PROGRESS_STAGE_LABELS[k]}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Upcoming({ m, today, can }: { m: CustomerMetrics; today: string; can: (p: Permission) => boolean }) {
  const s = useStyles();
  const g = m.migration;
  const next = g.siteList
    .filter((x) => !x.live && x.targetGoLive)
    .sort((a, b) => a.targetGoLive!.localeCompare(b.targetGoLive!))
    .slice(0, 6);
  const undated = g.siteList.filter((x) => !x.live && !x.targetGoLive).length;
  if (next.length === 0) {
    return (
      <Text size={200} className={s.muted}>
        {g.sitesLive === g.sites && g.sites > 0
          ? 'Every site is live.'
          : `No go-live dates yet. ${can('discovery:sites:manage') ? 'Set one on each site in Site Data to see what goes live next.' : ''}`}
      </Text>
    );
  }
  // One scale from today to the last date shown; an overdue site sits at the start, in red.
  const last = next[next.length - 1]!.targetGoLive!;
  const span = Math.max(14, (Date.parse(last) - Date.parse(today)) / DAY_MS);
  const pos = (d: string) => Math.max(0, Math.min(100, ((Date.parse(d) - Date.parse(today)) / DAY_MS / span) * 100));
  return (
    <div className={s.tl}>
      <div className={s.cardHead}>
        <Text className={s.cardTitle}>Next go-lives</Text>
        {undated > 0 && (
          <Text size={200} className={s.muted}>
            {undated} without a date
          </Text>
        )}
      </div>
      {next.map((x) => (
        <div key={x.id} className={s.tlRow}>
          <span className={s.tlName} title={x.name ?? x.sitecode}>
            <SiteLink site={x} can={can} /> <span className={s.muted}>{PROGRESS_STAGE_LABELS[x.stage]}</span>
          </span>
          <span className={s.tlTrack} title={x.goLive.reason ?? GO_LIVE_STATUS_LABELS[x.goLive.status]}>
            <span className={s.tlBar} style={{ left: 0, width: `${Math.max(3, pos(x.targetGoLive!))}%`, backgroundColor: STATUS_COLOR[x.goLive.status] }} />
          </span>
          <span className={s.tlDate}>
            {goLiveDateLabel(x.targetGoLive!).replace(/ \d{4}$/, '')}{' '}
            <Badge appearance="tint" size="small" color={STATUS_BADGE[x.goLive.status]}>
              {GO_LIVE_STATUS_LABELS[x.goLive.status]}
            </Badge>
          </span>
        </div>
      ))}
    </div>
  );
}

function SiteLink({ site, can }: { site: SiteMetrics; can: (p: Permission) => boolean }) {
  const s = useStyles();
  return can('discovery:read') ? (
    <RouterLink to={`/data-collection/sites/${site.id}`} className={s.link}>
      <b>{site.sitecode}</b>
    </RouterLink>
  ) : (
    <b>{site.sitecode}</b>
  );
}

/* ------------------------------ service health ------------------------------ */

function Ring({ pct, color }: { pct: number; color: string }) {
  const s = useStyles();
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className={s.ring} width="60" height="60" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="8" style={{ stroke: tokens.colorNeutralBackground3 }} />
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="8" strokeLinecap="round" strokeDasharray={c.toFixed(2)} strokeDashoffset={(c * (1 - pct / 100)).toFixed(2)} transform="rotate(-90 32 32)" style={{ stroke: color }} />
    </svg>
  );
}

function ServiceHealth({ m }: { m: CustomerMetrics }) {
  const s = useStyles();
  const cards: JSX.Element[] = [];
  if (m.incidents) {
    const p = m.incidents.targetsMetPct;
    cards.push(
      <Card key="inc" className={mergeClasses(s.card, s.healthCard)}>
        <div className={s.cardHead}>
          <Text className={s.cardTitle}>Incidents</Text>
          <Text size={200} className={s.muted}>30 days</Text>
        </div>
        <div className={s.healthRow}>
          <Ring pct={p ?? 0} color={p === null ? tokens.colorNeutralStroke1 : p >= 95 ? tokens.colorPaletteGreenBackground3 : p >= 85 ? tokens.colorPaletteMarigoldBackground3 : tokens.colorPaletteRedBackground3} />
          <div>
            <div className={s.big}>{p === null ? '–' : `${p}%`}</div>
            <Text size={200} className={s.muted}>
              of response and restore targets met · {m.incidents.raised} raised, {m.incidents.resolved} resolved
            </Text>
          </div>
        </div>
      </Card>,
    );
  }
  if (m.serviceRequests) {
    const r = m.serviceRequests;
    cards.push(
      <Card key="sr" className={mergeClasses(s.card, s.healthCard)}>
        <div className={s.cardHead}>
          <Text className={s.cardTitle}>Service requests</Text>
          <Text size={200} className={s.muted}>30 days</Text>
        </div>
        <div>
          <div className={s.big}>{r.medianHoursToComplete === null ? '–' : r.medianHoursToComplete < 48 ? `${r.medianHoursToComplete} h` : `${Math.round((r.medianHoursToComplete / 24) * 10) / 10} days`}</div>
          <Text size={200} className={s.muted}>
            median to complete · {r.completed} done · {r.open} open
          </Text>
        </div>
        {r.completed > 0 && r.completedByAssistants > 0 && (
          <Badge appearance="tint" color="brand" className={s.chip}>
            {pctOf(r.completedByAssistants, r.completed)}% completed with an assistant
          </Badge>
        )}
      </Card>,
    );
  }
  if (m.devices) {
    const d = m.devices;
    cards.push(
      <Card key="dev" className={mergeClasses(s.card, s.healthCard)}>
        <div className={s.cardHead}>
          <Text className={s.cardTitle}>Devices</Text>
          <Text size={200} className={s.muted}>24 hours</Text>
        </div>
        <div>
          <div className={s.big}>{d.availability24hPct === null ? '–' : `${d.availability24hPct}%`}</div>
          <Text size={200} className={s.muted}>
            available · {fmt(d.monitored)} monitored
          </Text>
        </div>
        {d.down > 0 ? (
          <Badge appearance="tint" color="warning" className={s.chip}>
            {d.down} down now
          </Badge>
        ) : (
          <Badge appearance="tint" color="success" className={s.chip}>
            All up
          </Badge>
        )}
      </Card>,
    );
  }
  if (cards.length === 0) {
    return (
      <Card className={s.card}>
        <Text className={s.cardTitle}>Service</Text>
        <Text size={200} className={s.muted}>
          Incidents, service requests and device monitoring appear here once Managed Services or Monitoring is switched on for this customer.
        </Text>
      </Card>
    );
  }
  return <div className={s.health}>{cards}</div>;
}

/* ------------------------------ needs a decision ------------------------------ */

function Decisions({ m, can }: { m: CustomerMetrics; can: (p: Permission) => boolean }) {
  const s = useStyles();
  const g = m.migration;
  const items: { key: string; color: string; icon: JSX.Element; title: string; detail: string; to: string | null }[] = [];
  for (const x of g.siteList.filter((y) => y.goLive.status === 'off_track' || y.goLive.status === 'at_risk')) {
    items.push({
      key: x.id,
      color: STATUS_COLOR[x.goLive.status],
      icon: x.goLive.status === 'off_track' ? <ErrorCircleRegular /> : <WarningRegular />,
      title: `${x.sitecode} ${x.goLive.status === 'off_track' ? 'is off track' : 'go-live is at risk'}`,
      detail: x.goLive.reason ?? '',
      to: can('discovery:read') ? `/data-collection/sites/${x.id}` : null,
    });
  }
  if (m.incidents && m.incidents.openP1 > 0) {
    items.push({
      key: 'p1',
      color: tokens.colorPaletteRedBackground3,
      icon: <ErrorCircleRegular />,
      title: `${m.incidents.openP1} priority 1 ${m.incidents.openP1 === 1 ? 'incident is' : 'incidents are'} open`,
      detail: 'A service is down or badly affected.',
      to: '/incidents',
    });
  }
  const undated = g.siteList.filter((x) => x.goLive.status === 'no_date').length;
  if (undated > 0 && can('discovery:sites:manage')) {
    items.push({
      key: 'dates',
      color: tokens.colorBrandBackground,
      icon: <CalendarLtrRegular />,
      title: `${undated} ${undated === 1 ? 'site has' : 'sites have'} no go-live date`,
      detail: 'Set a date on each site so the Overview can say whether it is on track.',
      to: '/data-collection',
    });
  }
  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <Text className={s.cardTitle}>Needs a decision</Text>
        {items.length > 0 && <Text size={200} className={s.muted}>{items.length}</Text>}
      </div>
      {items.length === 0 ? (
        <div className={s.okLine}>
          <CheckmarkCircleRegular />
          <Text size={200}>Nothing needs a decision right now.</Text>
        </div>
      ) : (
        <ul className={s.list}>
          {items.map((i) => (
            <li key={i.key} className={s.decision}>
              <span className={s.stripe} style={{ backgroundColor: i.color }} />
              <div>
                <Text weight="semibold" block>
                  {i.title}
                </Text>
                <Text size={200} className={s.muted}>
                  {i.detail}
                </Text>
              </div>
              {i.to && (
                <RouterLink to={i.to} className={s.link} aria-label={`Open: ${i.title}`}>
                  <ArrowRightRegular />
                </RouterLink>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------ loading ------------------------------ */

function OverviewSkeleton() {
  const s = useStyles();
  return (
    <Skeleton aria-label="Loading the overview" className={s.root}>
      <SkeletonItem className={s.skHero} />
      <div className={s.kpis}>
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonItem key={i} className={s.skTile} />
        ))}
      </div>
      <div className={s.two}>
        <SkeletonItem className={s.skCard} />
        <SkeletonItem className={s.skCard} />
      </div>
    </Skeleton>
  );
}
