import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router';
import { Badge, Button, Card, SearchBox, Spinner, Text, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { ArrowRightRegular, CheckmarkCircle16Filled, CheckmarkCircleRegular, Circle16Regular, Warning16Filled } from '@fluentui/react-icons';
import type {
  CustomerProgress,
  CustomerProgressItem,
  MeTenant,
  Permission,
  ProgressStage,
  ProgressStageViewKey,
  SiteProgressRow,
} from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { LoadError, useRecordStyles } from '../components/records';

const useLocalStyles = makeStyles({
  pl0: { justifySelf: "start", paddingLeft: '0px' },
  maxW320: { maxWidth: '320px' },
});


const useStyles = makeStyles({
  summary: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('8px', '24px'), alignItems: 'center' },
  list: { display: 'grid', ...shorthands.gap('6px'), ...shorthands.margin(0), ...shorthands.padding(0), listStyleType: 'none' },
  row: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', ...shorthands.gap('8px'), minHeight: '24px' },
  warn: { color: tokens.colorPaletteMarigoldForeground2, flexShrink: 0 },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  todo: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  site: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 160px) 1fr',
    ...shorthands.gap('8px', '16px'),
    ...shorthands.padding('12px', '0'),
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
    '@media (max-width: 720px)': { gridTemplateColumns: '1fr' },
  },
  siteName: { display: 'grid', alignContent: 'start', ...shorthands.gap('2px') },
  siteLink: {
    color: tokens.colorBrandForegroundLink,
    textDecorationLine: 'none',
    ':hover': { color: tokens.colorBrandForegroundLinkHover, textDecorationLine: 'underline' },
  },
  steps: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('6px'), ...shorthands.margin(0), ...shorthands.padding(0), listStyleType: 'none' },
  // Chips share the row evenly and wrap only when it is too narrow for all of them.
  stepItem: { flexGrow: 1, flexShrink: 1, flexBasis: '96px', maxWidth: '200px', minWidth: 0 },
  step: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: '6px',
    alignItems: 'center',
    boxSizing: 'border-box',
    height: '100%',
    ...shorthands.padding('6px', '10px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textDecorationLine: 'none',
  },
  stepLink: {
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1Hover) },
  },
  current: {
    backgroundColor: tokens.colorBrandBackground2,
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover, ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  stepDetail: {
    gridColumnStart: 2,
    color: tokens.colorNeutralForeground3,
    overflowX: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  blockers: { gridColumnStart: 2, display: 'grid', ...shorthands.gap('2px'), '@media (max-width: 720px)': { gridColumnStart: 1 } },
});

/** Which page each stage opens for a site, and the permission that page needs. */
function stageLink(key: ProgressStageViewKey, siteId: string): { to: string; permission: Permission } | null {
  switch (key) {
    case 'data_collection':
      return { to: `/data-collection/sites/${siteId}`, permission: 'discovery:read' };
    case 'designed':
    case 'validated':
      return { to: `/build/sites/${siteId}`, permission: 'build:read' };
    case 'dry_run':
    case 'deployed':
      return { to: `/deployment/sites/${siteId}`, permission: 'deployment:read' };
    case 'handover':
      return { to: '/handover', permission: 'handover:read' };
    case 'operations':
      return { to: '/service-requests', permission: 'sr:read' };
    default:
      return null; // 'delivery' - the project team's pages, not linked
  }
}

const ITEM_LINK: Record<CustomerProgressItem['kind'], { to: string; permission: Permission }> = {
  data_collection: { to: '/data-collection', permission: 'discovery:read' },
  discovery_sync: { to: '/discovery', permission: 'tenantdiscovery:read' },
  service_requests: { to: '/service-requests', permission: 'sr:read' },
};

const ATTENTION_PREVIEW = 8;

type LinkFor = (key: ProgressStageViewKey, siteId: string) => string | null;

export function Dashboard() {
  const { me, activeTenantId, can } = useAuth();
  const activeTenant = me?.tenants.find((t) => t.id === activeTenantId);

  const q = useQuery({
    queryKey: ['progress', activeTenantId],
    enabled: !!activeTenantId,
    // Runs and syncs finish in the background; keep the picture fresh without a reload.
    refetchInterval: 30_000,
    queryFn: () => api<CustomerProgress>(`/t/${activeTenantId}/progress`),
  });

  return (
    <Page platform
      title={`Welcome, ${me?.displayName ?? ''}`}
      subtitle={
        activeTenant
          ? `Active customer: ${activeTenant.name}`
          : me?.role === 'SUPER_ADMIN'
            ? 'Create a customer under Administration → Customers to begin.'
            : 'You have not been assigned to a customer yet.'
      }
    >
      {!activeTenantId ? null : q.isLoading ? (
        <Spinner label="Loading migration progress…" />
      ) : q.isError ? (
        <LoadError message={(q.error as Error).message} />
      ) : q.data ? (
        <ProgressView data={q.data} tenant={activeTenant} can={can} />
      ) : null}
    </Page>
  );
}

function ProgressView({ data, tenant, can }: { data: CustomerProgress; tenant: MeTenant | undefined; can: (p: Permission) => boolean }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const rs = useRecordStyles();
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  /** A page the signed-in user can open for this stage, or null. Handover packs are customer-wide, so site contacts can't. */
  const linkFor: LinkFor = (key, siteId) => {
    const l = stageLink(key, siteId);
    if (!l || !can(l.permission)) return null;
    if (key === 'handover' && tenant?.siteScoped) return null;
    if (key === 'operations' && !tenant?.managedServices) return null;
    return l.to;
  };

  const attention = [
    ...data.items
      .filter((i) => i.attention)
      .map((i) => ({ key: `item-${i.message}`, site: null, message: i.message, to: can(ITEM_LINK[i.kind].permission) ? ITEM_LINK[i.kind].to : null })),
    ...data.sites.flatMap((site) =>
      site.blockers.map((b) => ({ key: `${site.id}-${b.message}`, site: site.sitecode, message: b.message, to: linkFor(b.stage, site.id) })),
    ),
  ];
  const shown = showAll ? attention : attention.slice(0, ATTENTION_PREVIEW);
  // The Site Data status is already shown as a badge.
  const info = data.items.filter((i) => !i.attention && i.kind !== 'data_collection');

  const term = search.trim().toLowerCase();
  const sites = term
    ? data.sites.filter((x) => x.sitecode.toLowerCase().includes(term) || (x.name ?? '').toLowerCase().includes(term))
    : data.sites;
  const inOperations = data.sites.filter((x) => x.complete).length;

  return (
    <>
      <Card className={rs.card}>
        <div className={rs.cardHead}>
          <Text weight="semibold" size={400}>
            Needs attention {attention.length > 0 && <span className={rs.muted}>({attention.length})</span>}
          </Text>
        </div>
        {attention.length === 0 ? (
          <div className={s.row}>
            <CheckmarkCircleRegular className={s.ok} />
            <Text>Nothing needs attention right now.</Text>
          </div>
        ) : (
          <ul className={s.list}>
            {shown.map((a) => (
              <li key={a.key} className={s.row}>
                <Warning16Filled className={s.warn} />
                <Text>
                  {a.site && <Text weight="semibold">{a.site} · </Text>}
                  {a.message}
                </Text>
                {a.to && (
                  <RouterLink to={a.to} aria-label={`Open ${a.site ? `${a.site}: ` : ''}${a.message}`}>
                    <Button size="small" appearance="transparent" icon={<ArrowRightRegular />} iconPosition="after" tabIndex={-1}>
                      Open
                    </Button>
                  </RouterLink>
                )}
              </li>
            ))}
          </ul>
        )}
        {attention.length > ATTENTION_PREVIEW && (
          <Button appearance="transparent" size="small" onClick={() => setShowAll((v) => !v)} className={ls.pl0}>
            {showAll ? 'Show fewer' : `Show all ${attention.length}`}
          </Button>
        )}
        <div className={s.summary}>
          <Text size={200}>
            Site Data: <b>{data.dataCollection.accepted} of {data.dataCollection.sites}</b> sites accepted
            {data.dataCollection.submitted > 0 && ` · ${data.dataCollection.submitted} awaiting review`}
            {data.dataCollection.withChanges > 0 && ` · ${data.dataCollection.withChanges} changed since submitted`}
          </Text>
          {info.map((i) => (
            <Text key={i.message} size={200} className={rs.muted}>
              {i.message}
            </Text>
          ))}
        </div>
      </Card>

      <Card className={rs.card}>
        <div className={rs.cardHead}>
          <Text weight="semibold" size={400}>
            Sites{' '}
            <span className={rs.muted}>
              ({term ? `${sites.length} of ${data.sites.length}` : data.sites.length}
              {data.sites.length > 0 ? ` · ${inOperations} in service` : ''})
            </span>
          </Text>
        </div>
        {data.sites.length > 6 && (
          <SearchBox
            size="small"
            placeholder="Search by sitecode or name…"
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            className={ls.maxW320}
          />
        )}
        {data.sites.length === 0 ? (
          <Text size={200} className={rs.muted}>
            No sites yet{can('discovery:sites:manage') ? ' — add the first one in Sites admin.' : '.'}
          </Text>
        ) : sites.length === 0 ? (
          <Text size={200} className={rs.muted}>
            No sites match “{search}”.
          </Text>
        ) : (
          <>
            <Text size={200} className={rs.muted} block>
              Each site moves left to right. The shaded stage is where it is now; select a stage to open it.
            </Text>
            <div>
              {sites.map((site) => (
                <SiteRow key={site.id} site={site} linkFor={linkFor} />
              ))}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function SiteRow({ site, linkFor }: { site: SiteProgressRow; linkFor: LinkFor }) {
  const s = useStyles();
  const rs = useRecordStyles();
  const siteLink = linkFor('data_collection', site.id);
  return (
    <div className={s.site}>
      <div className={s.siteName}>
        <Text weight="semibold">
          {siteLink ? (
            <RouterLink to={siteLink} className={s.siteLink}>
              {site.sitecode}
            </RouterLink>
          ) : (
            site.sitecode
          )}
        </Text>
        {site.name && site.name !== site.sitecode && (
          <Text size={200} className={rs.muted}>
            {site.name}
          </Text>
        )}
      </div>
      <ol className={s.steps} aria-label={`${site.sitecode} migration stages`}>
        {site.stages.map((st) => (
          <li key={st.key} className={s.stepItem}>
            <StageChip stage={st} current={st.key === site.current} to={linkFor(st.key, site.id)} />
          </li>
        ))}
      </ol>
      {site.blockers.length > 0 && (
        <div className={s.blockers}>
          {site.blockers.map((b) => (
            <div key={b.message} className={s.row}>
              <Warning16Filled className={s.warn} />
              <Text size={200}>{b.message}</Text>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<ProgressStage['state'], string> = { done: 'done', attention: 'needs attention', todo: 'not started' };

function StageChip({ stage, current, to }: { stage: ProgressStage; current: boolean; to: string | null }) {
  const s = useStyles();
  const icon =
    stage.state === 'done' ? (
      <CheckmarkCircle16Filled className={s.ok} />
    ) : stage.state === 'attention' ? (
      <Warning16Filled className={s.warn} />
    ) : (
      <Circle16Regular className={s.todo} />
    );
  const body = (
    <>
      {icon}
      <Text size={200} weight={current ? 'semibold' : 'regular'}>
        {stage.label}
      </Text>
      {stage.detail && (
        <Text size={200} className={s.stepDetail}>
          {stage.detail}
        </Text>
      )}
    </>
  );
  const cls = mergeClasses(s.step, !!to && s.stepLink, current && s.current);
  const title = `${stage.label}: ${STATE_LABEL[stage.state]}${current ? ' (current stage)' : ''}${stage.detail ? ` - ${stage.detail}` : ''}`;
  return to ? (
    <RouterLink to={to} className={cls} aria-current={current ? 'step' : undefined} title={title} aria-label={title}>
      {body}
    </RouterLink>
  ) : (
    <div className={cls} aria-current={current ? 'step' : undefined} title={title} aria-label={title}>
      {body}
    </div>
  );
}
