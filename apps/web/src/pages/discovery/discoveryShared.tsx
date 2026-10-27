import { useState } from 'react';
import { Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Tab, TabList, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { CheckmarkRegular, ChevronLeftRegular, ChevronRightRegular, CopyRegular } from '@fluentui/react-icons';
import { TENANT_OBJECT_CHANGE_KIND_LABELS, type Paginated, type TenantDiscoveryChangeCounts, type TenantDiscoveryRun, type TenantObject, type TenantObjectChangeKind, type TenantObjectType } from '@tvmf/shared';
import { api } from '../../api';
import { JsonTree } from '../../components/JsonTree';
import { Page } from '../../components/Page';

const useLocalStyles = makeStyles({
  w94vwMaxW820: { maxWidth: '820px', width: "94vw" },
  mb8: { marginBottom: '8px' },
});


export const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', ...shorthands.gap('16px') },
  card: { ...shorthands.padding('16px'), display: 'grid', ...shorthands.gap('10px'), alignContent: 'start' },
  row: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), flexWrap: 'wrap' },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: tokens.fontSizeBase500,
    letterSpacing: '.08em',
    ...shorthands.padding('6px', '12px'),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  muted: { color: tokens.colorNeutralForeground3 },
  steps: { display: 'grid', ...shorthands.gap('4px'), marginTop: '4px' },
  step: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), fontSize: tokens.fontSizeBase200 },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', ...shorthands.gap('10px') },
  stat: { ...shorthands.padding('12px'), display: 'grid', ...shorthands.gap('2px') },
  statLink: { cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  statN: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: '1.1' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap('8px'), flexWrap: 'wrap' },
  chips: { display: 'flex', ...shorthands.gap('4px'), flexWrap: 'wrap' },
  json: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '60vh',
    overflowY: 'auto',
    ...shorthands.margin('0'),
    ...shorthands.padding('12px'),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', ...shorthands.gap('8px') },
  scopePanel: {
    display: 'grid',
    ...shorthands.gap('2px'),
    ...shorthands.padding('8px', '10px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  sessionPanel: {
    display: 'grid',
    ...shorthands.gap('4px'),
    ...shorthands.padding('6px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  sessionRow: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    ...shorthands.padding('7px', '9px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.borderLeft('3px', 'solid', 'transparent'),
    cursor: 'pointer',
    flexWrap: 'wrap',
    fontSize: tokens.fontSizeBase200,
  },
  scopeStep: { display: 'flex', alignItems: 'center', ...shorthands.gap('2px') },
  scopeTypes: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('2px', '14px'), paddingLeft: '28px' },
  diff: { display: 'grid', gridTemplateColumns: '1fr 1fr', ...shorthands.gap('10px') },
  diffCol: { display: 'grid', ...shorthands.gap('4px'), minWidth: 0 },
  diffLineSame: { color: tokens.colorNeutralForeground1 },
  diffLineAdded: { color: tokens.colorPaletteGreenForeground2, backgroundColor: tokens.colorPaletteGreenBackground1 },
  diffLineRemoved: { color: tokens.colorPaletteRedForeground1, backgroundColor: tokens.colorPaletteRedBackground1 },
});

export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

const ZERO_CHANGES: TenantDiscoveryChangeCounts = { added: 0, updated: 0, removed: 0, readded: 0 };

export const changeCountsOf = (run: TenantDiscoveryRun | null | undefined): TenantDiscoveryChangeCounts => {
  const c = run?.progress?.changed ?? (run?.summary?.changed as TenantDiscoveryChangeCounts | undefined);
  return c ? { ...ZERO_CHANGES, ...c } : ZERO_CHANGES;
};

export const totalChanges = (c: TenantDiscoveryChangeCounts) => c.added + c.updated + c.removed + c.readded;

const CHANGE_KIND_COLOR: Record<TenantObjectChangeKind, 'success' | 'warning' | 'danger' | 'brand'> = {
  added: 'success',
  updated: 'warning',
  removed: 'danger',
  readded: 'brand',
};

export function ChangeBadge({ kind }: { kind: TenantObjectChangeKind }) {
  return (
    <Badge appearance="tint" color={CHANGE_KIND_COLOR[kind]} size="small">
      {TENANT_OBJECT_CHANGE_KIND_LABELS[kind]}
    </Badge>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="small"
      appearance="subtle"
      icon={done ? <CheckmarkRegular /> : <CopyRegular />}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/* --------------------------- connect + run cards --------------------------- */

export function Pager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const s = useStyles();
  if (pages <= 1) return null;
  return (
    <div className={s.pager}>
      <Text size={200} className={s.muted}>
        Page {page} of {pages} · {total.toLocaleString()} total
      </Text>
      <Button size="small" appearance="subtle" icon={<ChevronLeftRegular />} disabled={page <= 1} onClick={() => onPage(page - 1)} />
      <Button size="small" appearance="subtle" icon={<ChevronRightRegular />} disabled={page >= pages} onClick={() => onPage(page + 1)} />
    </div>
  );
}

export function JsonDialog({ title, data, onClose }: { title: string; data: unknown; onClose: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [view, setView] = useState<'formatted' | 'raw'>('formatted');
  const text = JSON.stringify(data, null, 2);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w94vwMaxW820}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <TabList
              size="small"
              selectedValue={view}
              onTabSelect={(_, d) => setView(d.value as 'formatted' | 'raw')}
              className={ls.mb8}
            >
              <Tab value="formatted">Formatted</Tab>
              <Tab value="raw">Raw JSON</Tab>
            </TabList>
            {view === 'formatted' ? <JsonTree data={data} /> : <pre className={s.json}>{text}</pre>}
          </DialogContent>
          <DialogActions>
            <CopyButton text={text} label="Copy JSON" />
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The "as-is" call-flow diagram - built straight from Discovery's live
 * tenant_objects snapshot (buildCallFlowGraphFromLive), no Design & Build
 * populate step needed. tenant_objects has no site scoping, so a name
 * filter (matching the sitecode/name-prefix convention already used
 * elsewhere, e.g. Populate's own name matching) narrows a large tenant down
 * to one site's worth of Auto Attendants/Call Queues - schedules are always
 * fetched in full since a holiday/after-hours schedule's own name rarely
 * matches its AA's name filter.
 */
/**
 * The "as-is" call-flow diagram for one Auto Attendant or Call Queue,
 * straight from this tenant's live tenant_objects snapshot - the
 * counterpart to Design & Build's own per-object "as-designed" diagram
 * (AutoAttendantFlowDialog/CallQueueFlowDialog in BuildSiteWorkspace.tsx),
 * which reads the structured build_auto_attendants/build_call_queues
 * columns instead. For an Auto Attendant, every menu option that transfers
 * to another Auto Attendant is followed and expanded too (the sibling
 * Auto Attendant/Call Queue/Schedule lists are fetched tenant-wide to do
 * that, and to label a target with its real name) - a Call Queue's own
 * diagram needs no sibling fetch since it's always a leaf. The users list
 * is fetched either way, best-effort (capped at 200), to resolve a person
 * target's UPN instead of a raw Entra object id.
 */
/** Reads every page of a paginated list (200 at a time, up to 50,000 rows), as one page-shaped result. */
export async function fetchAllPages<T>(path: string): Promise<Paginated<T>> {
  const sep = path.endsWith('?') ? '' : path.includes('?') ? '&' : '?';
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= 250; page++) {
    const res = await api<Paginated<T>>(`${path}${sep}page=${page}&limit=200`);
    items.push(...res.items);
    total = res.total;
    if (items.length >= res.total || res.items.length === 0) break;
  }
  return { items, total, page: 1, limit: items.length };
}

export type TabKey =
  | 'overview'
  | 'changes'
  | 'users'
  | 'resource_accounts'
  | 'numbers'
  | 'policies'
  | 'voice_routing'
  | 'emergency'
  | 'voice_apps'
  | 'devices'
  | 'groups'
  | 'licences';

export const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'changes', label: 'Changes' },
  { key: 'users', label: 'Users' },
  { key: 'resource_accounts', label: 'Resource accounts' },
  { key: 'numbers', label: 'Phone numbers' },
  { key: 'policies', label: 'Policies' },
  { key: 'voice_routing', label: 'Voice routing' },
  { key: 'emergency', label: 'Emergency' },
  { key: 'voice_apps', label: 'Voice apps' },
  { key: 'devices', label: 'Devices' },
  { key: 'groups', label: 'M365 groups' },
  { key: 'licences', label: 'Licences & costs' },
];

/** The tab that lists what each Overview tile counts. */
export const TILE_TAB: Partial<Record<TenantObjectType, TabKey>> = {
  user: 'users',
  resource_account: 'resource_accounts',
  phone_number: 'numbers',
  policy: 'policies',
  pstn_usage: 'voice_routing',
  voice_route: 'voice_routing',
  pstn_gateway: 'voice_routing',
  emergency_location: 'emergency',
  civic_address: 'emergency',
  auto_attendant: 'voice_apps',
  call_queue: 'voice_apps',
  schedule: 'voice_apps',
};

export const str = (o: TenantObject, k: string) => {
  const v = o.data[k];
  return v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v);
};
