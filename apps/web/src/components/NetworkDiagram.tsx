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

/** subnet with the mask appended as CIDR, e.g. "10.20.0.0/24" */
const cidr = (r: NetworkRow) => `${r.subnet || '—'}${r.mask != null ? `/${r.mask}` : ''}`;
/** second line under a node — just the VLAN ID when set */
const sublabel = (r: NetworkRow) => (r.vlan_id != null ? `VLAN ${r.vlan_id}` : '');

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
      {/* chassis */}
      <rect x={-28} y={-11} width={56} height={22} rx={3} fill={BRAND} />
      <rect x={-28} y={-11} width={56} height={6} rx={3} fill={ACCENT} />
      {/* RJ45 port row */}
      {[-21, -13, -5, 3, 11, 19].map((px) => (
        <rect key={px} x={px} y={2} width={5.5} height={6} rx={1} fill="#ffffff" />
      ))}
      {/* link LEDs */}
      <circle cx={-22} cy={-4} r={1.8} fill="#8fe3a2" />
      <circle cx={-15} cy={-4} r={1.8} fill="#ffd666" />
    </g>
  );
}

function Wifi({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <g stroke={BRAND} strokeWidth={3.4} strokeLinecap="round" fill="none">
        <path d="M-20 -4 a28 28 0 0 1 40 0" />
        <path d="M-12 4 a17 17 0 0 1 24 0" />
        <path d="M-4 12 a7 7 0 0 1 8 0" />
      </g>
      <circle cx={0} cy={16} r={2.8} fill={BRAND} />
    </g>
  );
}

function Phone({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      {/* sloped base */}
      <path d="M-15 4 h30 l-3.5 15 h-23 Z" fill={BRAND} />
      {/* body + keypad */}
      <rect x={-15} y={-4} width={30} height={11} rx={2.5} fill={ACCENT} />
      {[-7, 0, 7].map((px) => (
        <circle key={px} cx={px} cy={1.5} r={1.7} fill="#ffffff" />
      ))}
      {/* handset */}
      <rect x={-17} y={-13} width={34} height={7} rx={3.5} fill={BRAND} />
    </g>
  );
}

function Person({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <circle cx={0} cy={-7} r={6.5} fill={STROKE} />
      <path d="M-11 13 a11 11 0 0 1 22 0 Z" fill={STROKE} />
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
      <g transform={`translate(${x - 22},${y})`}>{kind === 'wireless' ? <Wifi x={0} y={0} /> : <Switch x={0} y={0} />}</g>
      <g transform={`translate(${x + 30},${y})`}>{kind === 'voice' ? <Phone x={0} y={0} /> : <Person x={0} y={0} />}</g>
      <text x={x} y={y + 30} textAnchor="middle" fontSize={11.5} fontWeight={600} fill={TEXT} fontFamily={FONT}>
        {cidr(row)}
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
                {cidr(r)}
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
