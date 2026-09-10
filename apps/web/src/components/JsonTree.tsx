import { useState } from 'react';
import { Badge, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';

/**
 * Read-only, collapsible key/value view of an arbitrary JSON object - the
 * "Formatted" tab of the discovered-object dialogs. Values are lightly typed
 * (booleans as chips, null/empty muted, dates localised, phone numbers marked).
 */

const useStyles = makeStyles({
  root: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    maxHeight: '60vh',
    overflowY: 'auto',
    ...shorthands.padding('10px', '12px'),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  row: { display: 'flex', alignItems: 'baseline', ...shorthands.gap('6px') },
  toggle: {
    cursor: 'pointer',
    userSelect: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    ...shorthands.gap('4px'),
    color: tokens.colorNeutralForeground2,
  },
  key: { color: tokens.colorNeutralForeground2, fontWeight: tokens.fontWeightSemibold },
  children: {
    ...shorthands.borderLeft('1px', 'solid', tokens.colorNeutralStroke2),
    marginLeft: '7px',
    paddingLeft: '10px',
  },
  muted: { color: tokens.colorNeutralForeground4 },
  str: { color: tokens.colorPaletteGreenForeground2, wordBreak: 'break-word' },
  num: { color: tokens.colorPaletteBlueForeground2 },
  tel: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  count: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
  search: {
    width: '100%',
    boxSizing: 'border-box',
    marginBottom: '8px',
    ...shorthands.padding('4px', '8px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const looksLikeDate = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
const looksLikeTel = (s: string) => /^(tel:)?\+?\d[\d ()-]{5,}$/.test(s.trim());

function Leaf({ value }: { value: unknown }) {
  const s = useStyles();
  if (value === null || value === undefined || value === '')
    return <span className={s.muted}>—</span>;
  if (typeof value === 'boolean')
    return (
      <Badge size="small" appearance="tint" color={value ? 'success' : 'subtle'}>
        {value ? 'true' : 'false'}
      </Badge>
    );
  if (typeof value === 'number') return <span className={s.num}>{value.toLocaleString()}</span>;
  const str = String(value);
  if (looksLikeTel(str)) return <span className={s.tel}>{str}</span>;
  if (looksLikeDate(str)) {
    const d = new Date(str);
    return <span className={s.str}>{Number.isNaN(d.getTime()) ? str : d.toLocaleString()}</span>;
  }
  return <span className={s.str}>{str}</span>;
}

function Node({
  k,
  value,
  depth,
  filter,
}: {
  k: string | number | null;
  value: unknown;
  depth: number;
  filter: string;
}) {
  const s = useStyles();
  const container = Array.isArray(value) || isPlainObject(value);
  const [open, setOpen] = useState(depth < 1);

  const label = k === null ? null : <span className={s.key}>{k}</span>;

  if (!container) {
    return (
      <div className={s.row}>
        {label}
        {label && <span className={s.muted}>:</span>}
        <Leaf value={value} />
      </div>
    );
  }

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);

  // when filtering, only show branches that contain a matching key somewhere
  const matches = (kk: string | number, vv: unknown): boolean => {
    if (!filter) return true;
    if (String(kk).toLowerCase().includes(filter)) return true;
    if (isPlainObject(vv) || Array.isArray(vv)) {
      const ee: [string | number, unknown][] = Array.isArray(vv)
        ? vv.map((v, i) => [i, v])
        : Object.entries(vv as Record<string, unknown>);
      return ee.some(([a, b]) => matches(a, b));
    }
    return String(vv ?? '')
      .toLowerCase()
      .includes(filter);
  };
  const shown = entries.filter(([kk, vv]) => matches(kk, vv));
  if (filter && shown.length === 0) return null;

  return (
    <div>
      <span className={s.toggle} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDownRegular fontSize={12} /> : <ChevronRightRegular fontSize={12} />}
        {label ?? <span className={s.muted}>{Array.isArray(value) ? 'array' : 'object'}</span>}
        <span className={s.count}>
          {Array.isArray(value) ? `[${value.length}]` : `{${entries.length}}`}
        </span>
      </span>
      {open && (
        <div className={s.children}>
          {(filter ? shown : entries).map(([kk, vv]) => (
            <Node key={String(kk)} k={kk} value={vv} depth={depth + 1} filter={filter} />
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonTree({ data }: { data: unknown }) {
  const s = useStyles();
  const [q, setQ] = useState('');
  return (
    <div className={s.root}>
      <input
        className={s.search}
        placeholder="Filter keys / values…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {isPlainObject(data) || Array.isArray(data) ? (
        <Node k={null} value={data} depth={0} filter={q.trim().toLowerCase()} />
      ) : (
        <Leaf value={data} />
      )}
    </div>
  );
}
