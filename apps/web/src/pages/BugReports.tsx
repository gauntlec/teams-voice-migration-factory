import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Option,
  SearchBox,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  CheckmarkRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import {
  BUG_SEVERITIES,
  BUG_SEVERITY_LABELS,
  BUG_STATUSES,
  BUG_STATUS_LABELS,
  FEATURE_AREAS,
  type BugReport,
  type BugSeverity,
  type BugStatus,
  type FeatureArea,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';

/* --------------------------------- styles --------------------------------- */
// Mirrors apps/web/src/pages/FeatureRequests.tsx's board/card/dialog layout -
// same board pattern, bug-shaped fields.

const useStyles = makeStyles({
  board: {
    display: 'flex',
    ...shorthands.gap('12px'),
    alignItems: 'flex-start',
    overflowX: 'auto',
    ...shorthands.padding('4px', '2px', '12px'),
  },
  column: {
    flex: '0 0 280px',
    width: '280px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(100vh - 210px)',
  },
  columnOver: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorNeutralBackground2Hover },
  columnHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('10px', '12px'),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  columnBody: {
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.gap('8px'),
    ...shorthands.padding('8px'),
    overflowY: 'auto',
  },
  card: {
    ...shorthands.padding('10px'),
    display: 'grid',
    ...shorthands.gap('6px'),
    cursor: 'grab',
    // columnBody is a column-direction flex list, and Fluent's Card ships
    // its own `overflow: hidden` on the root - per the flexbox spec, a
    // flex item with non-visible overflow gets an automatic min-height of
    // 0 instead of one based on its content, so once a column's cards
    // exceed the column's available height, flexbox silently squashed
    // every card down to whatever height fit rather than leaving them at
    // their natural size and letting columnBody's own overflowY:auto
    // scroll - the second half of a wrapped title (or the note/footer
    // below it) was getting sheared off with no ellipsis, not just
    // visually truncated. flexShrink:0 makes cards report their real
    // content height instead.
    flexShrink: 0,
    // Width/style are fixed here; the actual hue is set per-card via an
    // inline `borderColor` (BUG_STATUS_COLOR) since it's data-driven, not a
    // fixed variant makeStyles can enumerate as its own class.
    ...shorthands.borderWidth('1.5px'),
    ...shorthands.borderStyle('solid'),
  },
  cardOpen: {
    display: 'grid',
    ...shorthands.gap('6px'),
    cursor: 'pointer',
    ...shorthands.margin('-4px', '-4px', '0'),
    ...shorthands.padding('4px'),
    ...shorthands.borderRadius(tokens.borderRadiusSmall),
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  cardTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, lineHeight: '1.3' },
  // Replaces a plain Badge for the "area" tag - Badge's `color` prop is
  // limited to 8 fixed semantic tokens (brand/danger/informative/etc), not
  // enough to give all 10 FEATURE_AREAS their own distinct hue, so this is
  // styled directly with AREA_COLOR's own fg/bg/border set inline per row.
  areaTag: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    lineHeight: '16px',
    ...shorthands.padding('1px', '7px'),
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    ...shorthands.border('1px', 'solid', 'transparent'),
  },
  // The small dot in front of each column title - the same hue as that
  // status's card border, so the color coding has a visible legend instead
  // of the viewer having to guess what each border color means.
  columnDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    ...shorthands.borderRadius(tokens.borderRadiusCircular),
    marginRight: '8px',
    flexShrink: 0,
  },
  columnTitle: { display: 'flex', alignItems: 'center' },
  noteClamp: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  detailSurface: { maxWidth: '640px', width: '92vw' },
  detailBody: { display: 'grid', ...shorthands.gap('12px') },
  detailField: { display: 'grid', ...shorthands.gap('2px') },
  detailLabel: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground3 },
  detailValue: { fontSize: tokens.fontSizeBase300, whiteSpace: 'pre-wrap', ...shorthands.margin('0') },
  tags: { display: 'flex', ...shorthands.gap('4px'), flexWrap: 'wrap', alignItems: 'center' },
  cardFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.gap('4px'),
  },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, ...shorthands.padding('8px') },
  formSurface: { maxWidth: '680px', width: '92vw' },
  form: { display: 'grid', ...shorthands.gap('12px'), width: '100%' },
  formRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', ...shorthands.gap('12px') },
});

/* ----------------------------- prompt builder ----------------------------- */

const SEVERITY_COLOR: Record<BugSeverity, 'danger' | 'warning' | 'informative' | 'subtle'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'informative',
  low: 'subtle',
};

/**
 * A card's border color, by status - roughly progressive (grey "just
 * arrived" -> blue "acknowledged" -> amber "being worked" -> green
 * "shipped"), with duplicate/won't-fix pulled aside in their own hues since
 * they're not really "further along" the same line. Mirrors
 * apps/web/src/pages/FeatureRequests.tsx's own FEATURE_STATUS_COLOR - same
 * idea, that board's own status set.
 */
const BUG_STATUS_COLOR: Record<BugStatus, string> = {
  new: tokens.colorPaletteSteelBorderActive,
  confirmed: tokens.colorPaletteCornflowerBorderActive,
  in_progress: tokens.colorPaletteMarigoldBorderActive,
  fixed: tokens.colorPaletteSeafoamBorderActive,
  deployed: tokens.colorPaletteGreenBorderActive,
  wont_fix: tokens.colorPaletteBeigeBorderActive,
  duplicate: tokens.colorPaletteGrapeBorderActive,
};

/**
 * The "area" tag's fg/bg/border, by platform area - FEATURE_AREAS is shared
 * between this board and FeatureRequests.tsx, and this exact map is
 * duplicated there (no shared component between the two boards - see the
 * flexShrink comment on `card` above), so an area reads as the same color
 * on either board.
 */
const AREA_COLOR: Record<FeatureArea, { fg: string; bg: string; border: string }> = {
  'Data Collection': { fg: tokens.colorPaletteBlueForeground2, bg: tokens.colorPaletteBlueBackground2, border: tokens.colorPaletteBlueBorderActive },
  Discovery: { fg: tokens.colorPaletteTealForeground2, bg: tokens.colorPaletteTealBackground2, border: tokens.colorPaletteTealBorderActive },
  'Design & Build': { fg: tokens.colorPalettePurpleForeground2, bg: tokens.colorPalettePurpleBackground2, border: tokens.colorPalettePurpleBorderActive },
  Deployment: { fg: tokens.colorPalettePumpkinForeground2, bg: tokens.colorPalettePumpkinBackground2, border: tokens.colorPalettePumpkinBorderActive },
  'Service Handover': { fg: tokens.colorPaletteLavenderForeground2, bg: tokens.colorPaletteLavenderBackground2, border: tokens.colorPaletteLavenderBorderActive },
  'Users & Access': { fg: tokens.colorPalettePinkForeground2, bg: tokens.colorPalettePinkBackground2, border: tokens.colorPalettePinkBorderActive },
  'Email & Notifications': { fg: tokens.colorPaletteGoldForeground2, bg: tokens.colorPaletteGoldBackground2, border: tokens.colorPaletteGoldBorderActive },
  'Reporting & Exports': { fg: tokens.colorPaletteForestForeground2, bg: tokens.colorPaletteForestBackground2, border: tokens.colorPaletteForestBorderActive },
  'Platform & Infrastructure': { fg: tokens.colorPaletteMinkForeground2, bg: tokens.colorPaletteMinkBackground2, border: tokens.colorPaletteMinkBorderActive },
  Other: { fg: tokens.colorPalettePlatinumForeground2, bg: tokens.colorPalettePlatinumBackground2, border: tokens.colorPalettePlatinumBorderActive },
};

function buildClaudePrompt(b: BugReport): string {
  const na = '_Not specified._';
  const lines: (string | null)[] = [
    `# Bug report: ${b.title}`,
    '',
    `- **Area:** ${b.area}`,
    `- **Severity:** ${BUG_SEVERITY_LABELS[b.severity]}`,
    b.affected_customer ? `- **Affected customer/tenant:** ${b.affected_customer}` : null,
    b.environment ? `- **Environment:** ${b.environment}` : null,
    b.reported_by_name ? `- **Reported by:** ${b.reported_by_name}` : null,
    '',
    '## Steps to reproduce',
    b.steps_to_reproduce,
    '',
    '## Expected behaviour',
    b.expected_behavior,
    '',
    '## Actual behaviour',
    b.actual_behavior,
    '',
    '## Resolution notes so far',
    b.resolution_note || na,
    '',
    '---',
    'Reproduce this in the codebase today, find the root cause, and fix it following the repo conventions in `docs/ARCHITECTURE.md` (shared `DataTable`, `makeStyles` for styling, RBAC in `packages/shared/src/rbac.ts`, plain-SQL migrations, zod DTOs in `packages/shared/src/dto.ts`). Typecheck every workspace and build the web app before finishing. When the fix ships, set this bug report to "Deployed".',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
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

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* --------------------------------- form ---------------------------------- */

interface FormState {
  title: string;
  area: FeatureArea | '';
  severity: BugSeverity;
  steps_to_reproduce: string;
  expected_behavior: string;
  actual_behavior: string;
  affected_customer: string;
  environment: string;
  resolution_note: string;
}

const emptyForm: FormState = {
  title: '',
  area: '',
  severity: 'medium',
  steps_to_reproduce: '',
  expected_behavior: '',
  actual_behavior: '',
  affected_customer: '',
  environment: '',
  resolution_note: '',
};

function toForm(b: BugReport): FormState {
  return {
    title: b.title,
    area: b.area,
    severity: b.severity,
    steps_to_reproduce: b.steps_to_reproduce,
    expected_behavior: b.expected_behavior,
    actual_behavior: b.actual_behavior,
    affected_customer: b.affected_customer ?? '',
    environment: b.environment ?? '',
    resolution_note: b.resolution_note ?? '',
  };
}

function BugForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial?: BugReport;
  onClose: () => void;
  onSaved: () => void;
}) {
  const s = useStyles();
  const [v, setV] = useState<FormState>(initial ? toForm(initial) : emptyForm);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => setV((p) => ({ ...p, [k]: val }));

  const save = useMutation({
    mutationFn: () => {
      const base = {
        title: v.title.trim(),
        area: v.area || undefined,
        severity: v.severity,
        steps_to_reproduce: v.steps_to_reproduce.trim(),
        expected_behavior: v.expected_behavior.trim(),
        actual_behavior: v.actual_behavior.trim(),
        affected_customer: v.affected_customer.trim(),
        environment: v.environment.trim(),
      };
      return mode === 'create'
        ? api('/bug-reports', { method: 'POST', body: JSON.stringify(base) })
        : api(`/bug-reports/${initial!.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...base, resolution_note: v.resolution_note.trim() }),
          });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const missing =
    v.title.trim().length < 6 ||
    !v.area ||
    v.steps_to_reproduce.trim().length < 10 ||
    v.expected_behavior.trim().length < 5 ||
    v.actual_behavior.trim().length < 5;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.formSurface}>
        <DialogBody>
          <DialogTitle>{mode === 'create' ? 'New bug report' : 'Edit bug report'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field
                label="Title"
                required
                hint="One specific line. e.g. “Deployment preview shows commands for unchanged users”, not “deployment bug”."
              >
                <Input value={v.title} maxLength={160} onChange={(_, d) => set('title', d.value)} />
              </Field>

              <div className={s.formRow}>
                <Field label="Area" required hint="Which part of the product this is in.">
                  <Dropdown
                    placeholder="Select…"
                    selectedOptions={v.area ? [v.area] : []}
                    value={v.area}
                    onOptionSelect={(_, d) => set('area', (d.optionValue ?? '') as FeatureArea)}
                  >
                    {FEATURE_AREAS.map((a) => (
                      <Option key={a} value={a}>
                        {a}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Severity" hint="Your view of impact — an admin can adjust it.">
                  <Dropdown
                    selectedOptions={[v.severity]}
                    value={BUG_SEVERITY_LABELS[v.severity]}
                    onOptionSelect={(_, d) => set('severity', (d.optionValue as BugSeverity) ?? 'medium')}
                  >
                    {BUG_SEVERITIES.map((sv) => (
                      <Option key={sv} value={sv}>
                        {BUG_SEVERITY_LABELS[sv]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>

              <Field
                label="Steps to reproduce"
                required
                hint="Numbered steps from a clean start, with real values where it matters."
              >
                <Textarea
                  value={v.steps_to_reproduce}
                  resize="vertical"
                  rows={4}
                  onChange={(_, d) => set('steps_to_reproduce', d.value)}
                />
              </Field>

              <div className={s.formRow}>
                <Field label="Expected behaviour" required hint="What should have happened.">
                  <Textarea
                    value={v.expected_behavior}
                    resize="vertical"
                    rows={3}
                    onChange={(_, d) => set('expected_behavior', d.value)}
                  />
                </Field>
                <Field label="Actual behaviour" required hint="What happened instead. Include error text if any.">
                  <Textarea
                    value={v.actual_behavior}
                    resize="vertical"
                    rows={3}
                    onChange={(_, d) => set('actual_behavior', d.value)}
                  />
                </Field>
              </div>

              <div className={s.formRow}>
                <Field label="Affected customer / tenant" hint="If specific to one customer. Optional.">
                  <Input
                    value={v.affected_customer}
                    maxLength={160}
                    onChange={(_, d) => set('affected_customer', d.value)}
                  />
                </Field>
                <Field label="Environment" hint="Browser/OS, URL, role signed in as, etc. Optional.">
                  <Input
                    value={v.environment}
                    maxLength={500}
                    onChange={(_, d) => set('environment', d.value)}
                  />
                </Field>
              </div>

              {mode === 'edit' && (
                <Field
                  label="Resolution note"
                  hint="Root cause, fix summary, or why it won't be fixed. Shown on the card."
                >
                  <Textarea
                    value={v.resolution_note}
                    resize="vertical"
                    rows={2}
                    onChange={(_, d) => set('resolution_note', d.value)}
                  />
                </Field>
              )}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={missing || save.isPending} onClick={() => save.mutate()}>
              {mode === 'create' ? 'Submit report' : 'Save changes'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------ detail dialog --------------------------- */

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  const s = useStyles();
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={s.detailField}>
      <span className={s.detailLabel}>{label}</span>
      <p className={s.detailValue}>{value}</p>
    </div>
  );
}

function DetailDialog({
  b,
  canManage,
  onEdit,
  onClose,
}: {
  b: BugReport;
  canManage: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.detailSurface}>
        <DialogBody>
          <DialogTitle>{b.title}</DialogTitle>
          <DialogContent>
            <div className={s.detailBody}>
              <div className={s.tags}>
                <Badge appearance="tint" color={SEVERITY_COLOR[b.severity]} size="small">
                  {BUG_SEVERITY_LABELS[b.severity]}
                </Badge>
                <span
                  className={s.areaTag}
                  style={{ color: AREA_COLOR[b.area].fg, backgroundColor: AREA_COLOR[b.area].bg, borderColor: AREA_COLOR[b.area].border }}
                >
                  {b.area}
                </span>
                <span
                  className={s.areaTag}
                  style={{ color: BUG_STATUS_COLOR[b.status], backgroundColor: 'transparent', borderColor: BUG_STATUS_COLOR[b.status] }}
                >
                  {BUG_STATUS_LABELS[b.status]}
                </span>
              </div>
              <DetailRow
                label="Reported by"
                value={`${b.reported_by_name ?? 'Unknown'} · ${timeAgo(b.created_at)}`}
              />
              <DetailRow label="Affected customer / tenant" value={b.affected_customer} />
              <DetailRow label="Environment" value={b.environment} />
              <DetailRow label="Steps to reproduce" value={b.steps_to_reproduce} />
              <DetailRow label="Expected behaviour" value={b.expected_behavior} />
              <DetailRow label="Actual behaviour" value={b.actual_behavior} />
              <DetailRow label="Resolution note" value={b.resolution_note} />
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="subtle"
              icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
              onClick={async () => {
                if (await copyText(buildClaudePrompt(b))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy prompt'}
            </Button>
            {canManage && (
              <Button
                appearance="secondary"
                icon={<EditRegular />}
                onClick={() => {
                  onClose();
                  onEdit();
                }}
              >
                Edit
              </Button>
            )}
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* --------------------------------- card ---------------------------------- */

function BugCard({
  b,
  canManage,
  onOpen,
  onEdit,
  onMove,
  onDelete,
}: {
  b: BugReport;
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: (status: BugStatus) => void;
  onDelete: () => void;
}) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(buildClaudePrompt(b));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Card
      className={s.card}
      style={{ borderColor: BUG_STATUS_COLOR[b.status] }}
      draggable={canManage}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', b.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div
        className={s.cardOpen}
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        title="View details"
      >
        <div className={s.cardTitle}>{b.title}</div>
        <div className={s.tags}>
          <Badge appearance="tint" color={SEVERITY_COLOR[b.severity]} size="small">
            {BUG_SEVERITY_LABELS[b.severity]}
          </Badge>
          <span
            className={s.areaTag}
            style={{ color: AREA_COLOR[b.area].fg, backgroundColor: AREA_COLOR[b.area].bg, borderColor: AREA_COLOR[b.area].border }}
          >
            {b.area}
          </span>
        </div>
        {b.resolution_note && <div className={s.noteClamp}>Note: {b.resolution_note}</div>}
      </div>
      <div className={s.cardFoot}>
        <Text className={s.meta}>
          {b.reported_by_name ?? 'Unknown'} · {timeAgo(b.created_at)}
        </Text>
        <div style={{ display: 'flex', gap: 2 }}>
          <Button
            size="small"
            appearance="subtle"
            icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
            onClick={copy}
            title="Copy the prompt for Claude"
            aria-label="Copy the prompt for Claude"
          >
            {copied ? 'Copied' : 'Prompt'}
          </Button>
          {canManage && (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<MoreHorizontalRegular />}
                  aria-label="More actions"
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem icon={<EditRegular />} onClick={onEdit}>
                    Edit…
                  </MenuItem>
                  {BUG_STATUSES.filter((st) => st !== b.status).map((st) => (
                    <MenuItem key={st} onClick={() => onMove(st)}>
                      Move to {BUG_STATUS_LABELS[st]}
                    </MenuItem>
                  ))}
                  <MenuItem icon={<DeleteRegular />} onClick={onDelete}>
                    Delete
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------- page ---------------------------------- */

export function BugReports() {
  const s = useStyles();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('bug:manage');
  const canCreate = can('bug:create');

  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; b: BugReport } | null>(null);
  const [detail, setDetail] = useState<BugReport | null>(null);
  const [overCol, setOverCol] = useState<BugStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BugReport | null>(null);
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['bug-reports'],
    queryFn: () => api<BugReport[]>('/bug-reports'),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['bug-reports'] });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: BugStatus }) =>
      api(`/bug-reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/bug-reports/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(null);
      invalidate();
    },
  });

  const byStatus = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = term
      ? (list.data ?? []).filter(
          (b) => b.title.toLowerCase().includes(term) || (b.affected_customer ?? '').toLowerCase().includes(term),
        )
      : (list.data ?? []);
    const m = new Map<BugStatus, BugReport[]>();
    for (const st of BUG_STATUSES) m.set(st, []);
    for (const b of rows) m.get(b.status)?.push(b);
    return m;
  }, [list.data, search]);

  const actions: ReactNode = canCreate ? (
    <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialog({ mode: 'create' })}>
      New bug report
    </Button>
  ) : undefined;

  return (
    <Page
      title="Bug reports"
      subtitle="Defects found in the platform itself. An admin moves a card through triage as it's confirmed, fixed and shipped."
      actions={actions}
    >
      <SearchBox
        size="small"
        placeholder="Search by title or affected customer…"
        value={search}
        onChange={(_, d) => setSearch(d.value)}
        style={{ maxWidth: 320, marginBottom: 8 }}
      />
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>{(list.error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : (
        <div className={s.board}>
          {BUG_STATUSES.map((st) => {
            const items = byStatus.get(st) ?? [];
            return (
              <div
                key={st}
                className={mergeClasses(s.column, overCol === st && s.columnOver)}
                onDragOver={(e) => {
                  if (!canManage) return;
                  e.preventDefault();
                  if (overCol !== st) setOverCol(st);
                }}
                onDragLeave={() => setOverCol((c) => (c === st ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverCol(null);
                  const id = e.dataTransfer.getData('text/plain');
                  const cur = (list.data ?? []).find((b) => b.id === id);
                  if (id && cur && cur.status !== st) move.mutate({ id, status: st });
                }}
              >
                <div className={s.columnHead}>
                  <span className={s.columnTitle}>
                    <span className={s.columnDot} style={{ backgroundColor: BUG_STATUS_COLOR[st] }} />
                    {BUG_STATUS_LABELS[st]}
                  </span>
                  <Badge appearance="tint" color="informative" size="small">
                    {items.length}
                  </Badge>
                </div>
                <div className={s.columnBody}>
                  {items.length === 0 ? (
                    <div className={s.empty}>Nothing here.</div>
                  ) : (
                    items.map((b) => (
                      <BugCard
                        key={b.id}
                        b={b}
                        canManage={canManage}
                        onOpen={() => setDetail(b)}
                        onEdit={() => setDialog({ mode: 'edit', b })}
                        onMove={(status) => move.mutate({ id: b.id, status })}
                        onDelete={() => setConfirmDelete(b)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detail && (
        <DetailDialog
          b={(list.data ?? []).find((x) => x.id === detail.id) ?? detail}
          canManage={canManage}
          onEdit={() => setDialog({ mode: 'edit', b: detail })}
          onClose={() => setDetail(null)}
        />
      )}

      {dialog?.mode === 'create' && (
        <BugForm mode="create" onClose={() => setDialog(null)} onSaved={invalidate} />
      )}
      {dialog?.mode === 'edit' && (
        <BugForm mode="edit" initial={dialog.b} onClose={() => setDialog(null)} onSaved={invalidate} />
      )}

      {confirmDelete && (
        <Dialog open onOpenChange={(_, d) => !d.open && setConfirmDelete(null)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete this bug report?</DialogTitle>
              <DialogContent>
                “{confirmDelete.title}” will be permanently removed. This cannot be undone.
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  style={{ backgroundColor: tokens.colorPaletteRedBackground3 }}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(confirmDelete.id)}
                >
                  Delete
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </Page>
  );
}
