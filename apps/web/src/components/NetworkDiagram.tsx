import { NETWORK_LOCATIONS } from '@tvmf/shared';

/**
 * Live network diagram for the Network (E911) tab. Redraws from the subnet rows
 * the customer enters:
 *   - office building in the centre
 *   - one connector to the internet cloud per "External Subnet" row
 *   - switch + person per "User VLAN", switch + phone per "Voice/VOIP VLAN",
 *     Wi-Fi + person per "Wireless VLAN"
 * Pure inline SVG, no icon dependency; palette matches theme.ts.
 */

export interface NetworkRow {
  id: string;
  subnet: string | null;
  mask: number | null;
  location: string | null;
  vlan_id: number | null;
}

const BRAND = '#4657D2';
const ACCENT = '#5B5FC7';
const LINE = '#9aa0d4';
const STROKE = '#5b5f7a';
const TEXT = '#242424';
const MUTED = '#616161';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const W = 1000;
const STEP = 96;
const SIDE_TOP = 156;
const LEFT_X = 150;
const RIGHT_X = W - 150;
const CLOUD_Y = 74;

const sublabel = (r: NetworkRow) =>
  [r.mask != null ? `/${r.mask}` : null, r.vlan_id != null ? `VLAN ${r.vlan_id}` : null]
    .filter(Boolean)
    .join(' · ');

/* ------------------------------- glyphs ------------------------------- */

function Building({ x, y }: { x: number; y: number }) {
  const cols = [-42, -14, 14, 42];
  const rows = [-38, -10, 18];
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={-66} y={-58} width={132} height={116} rx={6} fill="#ffffff" stroke={STROKE} strokeWidth={2} />
      <rect x={-66} y={-58} width={132} height={16} rx={6} fill={BRAND} />
      {rows.map((ry) =>
        cols.map((cx) => (
          <rect key={`${cx}-${ry}`} x={cx - 8} y={ry - 7} width={16} height={14} rx={2} fill="#dfe1f5" stroke={STROKE} strokeWidth={1} />
        )),
      )}
      <rect x={-13} y={36} width={26} height={22} rx={2} fill={ACCENT} />
      <text x={0} y={78} textAnchor="middle" fontSize={13} fontWeight={600} fill={TEXT} fontFamily={FONT}>
        Office
      </text>
    </g>
  );
}

function Cloud({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <path
        d="M-46 12 a20 20 0 0 1 4 -39 a26 26 0 0 1 49 -6 a18 18 0 0 1 24 17 a16 16 0 0 1 -3 33 Z"
        fill="#ffffff"
        stroke={STROKE}
        strokeWidth={2}
      />
      <text x={4} y={4} textAnchor="middle" fontSize={12} fontWeight={600} fill={MUTED} fontFamily={FONT}>
        Internet
      </text>
    </g>
  );
}

function Switch({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={-26} y={-12} width={52} height={24} rx={4} fill={BRAND} />
      {[-18, -6, 6, 18].map((px) => (
        <rect key={px} x={px - 3} y={4} width={6} height={5} rx={1} fill="#ffffff" />
      ))}
      <circle cx={-18} cy={-4} r={2} fill="#8fe3a2" />
      <circle cx={-10} cy={-4} r={2} fill="#8fe3a2" />
    </g>
  );
}

function Wifi({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={-20} y={4} width={40} height={12} rx={4} fill={BRAND} />
      <circle cx={0} cy={10} r={2} fill="#ffffff" />
      <path d="M-14 -2 a20 20 0 0 1 28 0" fill="none" stroke={ACCENT} strokeWidth={3} strokeLinecap="round" />
      <path d="M-8 -8 a11 11 0 0 1 16 0" fill="none" stroke={ACCENT} strokeWidth={3} strokeLinecap="round" />
    </g>
  );
}

function Phone({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={-18} y={0} width={36} height={16} rx={3} fill={ACCENT} />
      {[-10, 0, 10].map((px) => (
        <rect key={px} x={px - 3} y={5} width={6} height={2.5} rx={1} fill="#ffffff" />
      ))}
      <path d="M-16 -4 q-4 -12 8 -12 h16 q12 0 8 12 q-6 -3 -10 -3 h-12 q-4 0 -10 3 Z" fill={BRAND} />
    </g>
  );
}

function Person({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <circle cx={0} cy={-6} r={6} fill={STROKE} />
      <path d="M-10 12 a10 10 0 0 1 20 0 Z" fill={STROKE} />
    </g>
  );
}

/* --------------------------- node + connectors --------------------------- */

function VlanNode({
  x,
  y,
  kind,
  row,
}: {
  x: number;
  y: number;
  kind: 'user' | 'voice' | 'wireless';
  row: NetworkRow;
}) {
  const sub = sublabel(row);
  return (
    <g>
      <g transform={`translate(${x - 15},${y})`}>{kind === 'wireless' ? <Wifi x={0} y={0} /> : <Switch x={0} y={0} />}</g>
      <g transform={`translate(${x + 26},${y})`}>{kind === 'voice' ? <Phone x={0} y={0} /> : <Person x={0} y={0} />}</g>
      <text x={x} y={y + 28} textAnchor="middle" fontSize={11.5} fontWeight={600} fill={TEXT} fontFamily={FONT}>
        {row.subnet || '—'}
      </text>
      {sub && (
        <text x={x} y={y + 42} textAnchor="middle" fontSize={10.5} fill={MUTED} fontFamily={FONT}>
          {sub}
        </text>
      )}
    </g>
  );
}

export function NetworkDiagram({ rows }: { rows: NetworkRow[] }) {
  const pick = (loc: string) => rows.filter((r) => r.location === loc);
  const external = pick('External Subnet');
  const user = pick('User VLAN');
  const voice = pick('Voice/VOIP VLAN');
  const wireless = pick('Wireless VLAN');
  const uncategorised = rows.filter(
    (r) => !(NETWORK_LOCATIONS as readonly string[]).includes(r.location ?? ''),
  ).length;

  const sideMax = Math.max(user.length, voice.length, 1);
  const colH = sideMax * STEP;
  const cy = Math.max(250, SIDE_TOP + colH / 2 - STEP / 2 + 6);
  const bTop = cy - 58;
  const bBottom = cy + 58;
  const wRowY = bBottom + 96;
  const H = wireless.length
    ? wRowY + 62
    : Math.max(SIDE_TOP + colH + 8, bBottom + 40);

  const shownExt = Math.min(external.length, 6);
  const wStartX = 500 - ((wireless.length - 1) * 150) / 2;

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 640, display: 'block' }} role="img" aria-label="Network diagram">
        {/* external subnet connectors */}
        {external.slice(0, shownExt).map((r, i) => {
          const off = (i - (shownExt - 1) / 2) * 30;
          return (
            <g key={r.id}>
              <line x1={500 + off} y1={bTop} x2={500} y2={CLOUD_Y + 20} stroke={LINE} strokeWidth={2} />
              <text
                x={500 + off + (off >= 0 ? 6 : -6)}
                y={(bTop + CLOUD_Y) / 2}
                textAnchor={off >= 0 ? 'start' : 'end'}
                fontSize={10.5}
                fill={MUTED}
                fontFamily={FONT}
              >
                {r.subnet || '—'}
              </text>
            </g>
          );
        })}
        <Cloud x={500} y={CLOUD_Y} />
        {external.length > shownExt && (
          <text x={560} y={CLOUD_Y + 4} fontSize={10.5} fill={MUTED} fontFamily={FONT}>
            +{external.length - shownExt} more
          </text>
        )}

        {/* left: user VLANs */}
        {user.map((r, i) => {
          const y = SIDE_TOP + i * STEP;
          return (
            <g key={r.id}>
              <line x1={LEFT_X + 40} y1={y} x2={434} y2={cy} stroke={LINE} strokeWidth={2} />
              <VlanNode x={LEFT_X} y={y} kind="user" row={r} />
            </g>
          );
        })}

        {/* right: voice VLANs */}
        {voice.map((r, i) => {
          const y = SIDE_TOP + i * STEP;
          return (
            <g key={r.id}>
              <line x1={RIGHT_X - 40} y1={y} x2={566} y2={cy} stroke={LINE} strokeWidth={2} />
              <VlanNode x={RIGHT_X} y={y} kind="voice" row={r} />
            </g>
          );
        })}

        {/* bottom: wireless VLANs */}
        {wireless.map((r, i) => {
          const x = wStartX + i * 150;
          return (
            <g key={r.id}>
              <line x1={x} y1={wRowY - 22} x2={500} y2={bBottom} stroke={LINE} strokeWidth={2} />
              <VlanNode x={x} y={wRowY} kind="wireless" row={r} />
            </g>
          );
        })}

        <Building x={500} y={cy} />
      </svg>

      {uncategorised > 0 && (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED, fontFamily: FONT }}>
          {uncategorised} subnet{uncategorised === 1 ? '' : 's'} not shown — set a Location to add
          {uncategorised === 1 ? ' it' : ' them'} to the diagram.
        </p>
      )}
    </div>
  );
}
