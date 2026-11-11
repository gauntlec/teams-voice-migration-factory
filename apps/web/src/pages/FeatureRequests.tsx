import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Link,
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
import { Dialog } from '../components/AppDialog';
import {
  AddRegular,
  AttachRegular,
  CheckmarkRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import {
  FEATURE_AREAS,
  FEATURE_PRIORITIES,
  FEATURE_PRIORITY_LABELS,
  FEATURE_STATUSES,
  FEATURE_STATUS_LABELS,
  ROLES,
  type FeatureArea,
  type FeaturePriority,
  type FeatureRequest,
  type FeatureRequestAttachment,
  FEATURE_ATTACHMENT_MAX_BYTES,
  type FeatureStatus,
  type Role,
  boardRepliesForPrompt,
  type BoardReply,
} from '@tvmf/shared';
import { api, apiDownload, apiUpload, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';
import { CardReplies, ReplyCount, copyText, copyTextLater, fetchReplies } from '../components/CardReplies';

const useLocalStyles = makeStyles({
  flexGap2: { display: "flex", ...shorthands.gap('2px') },
  maxW320Mb8: { maxWidth: '320px', marginBottom: '8px' },
  dangerFill: { backgroundColor: tokens.colorPaletteRedBackground3 },
});


/* --------------------------------- styles --------------------------------- */

const useStyles = makeStyles({
  board: {
    display: 'flex',
    ...shorthands.gap('12px'),
    alignItems: 'flex-start',
    overflowX: 'auto',
    ...shorthands.padding('4px', '2px', '12px'),
  },
  column: {
    flex: '0 0 300px',
    width: '300px',
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
    // Mirrors apps/web/src/pages/BugReports.tsx's own card style - see the
    // comment there. columnBody is a column-direction flex list, and
    // Fluent's Card ships its own `overflow: hidden`, so once a column's
    // cards exceed the column's available height, flexbox was silently
    // squashing every card down (its automatic min-height resolves to 0
    // with non-visible overflow) instead of leaving them at their natural
    // size and letting columnBody's own overflowY:auto scroll.
    flexShrink: 0,
    // Width/style are fixed here; the actual hue is set per-card via an
    // inline `borderColor` (FEATURE_STATUS_COLOR) since it's data-driven,
    // not a fixed variant makeStyles can enumerate as its own class.
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
  // Mirrors apps/web/src/pages/BugReports.tsx's own areaTag/columnDot.
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
  guide: {
    ...shorthands.padding('10px', '12px'),
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  guideList: { ...shorthands.margin('4px', '0', '0'), ...shorthands.padding('0', '0', '0', '18px'), display: 'grid', ...shorthands.gap('2px') },
});

/* ----------------------------- prompt builder ----------------------------- */

const PRIORITY_COLOR: Record<FeaturePriority, 'danger' | 'warning' | 'informative' | 'subtle'> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'informative',
  low: 'subtle',
};

/**
 * A card's border color, by status - roughly progressive (grey "just
 * arrived" -> blue "under review" -> purple "scheduled" -> amber "being
 * built" -> green "shipped"), with declined pulled aside in its own muted
 * hue since it's not "further along" the same line. Mirrors
 * apps/web/src/pages/BugReports.tsx's own BUG_STATUS_COLOR - same idea,
 * that board's own status set.
 */
const FEATURE_STATUS_COLOR: Record<FeatureStatus, string> = {
  new: tokens.colorPaletteSteelBorderActive,
  under_review: tokens.colorPaletteCornflowerBorderActive,
  scheduled: tokens.colorPaletteGrapeBorderActive,
  in_development: tokens.colorPaletteMarigoldBorderActive,
  deployed: tokens.colorPaletteGreenBorderActive,
  declined: tokens.colorPaletteBeigeBorderActive,
};

/**
 * The "area" tag's fg/bg/border, by platform area - FEATURE_AREAS is shared
 * between this board and BugReports.tsx, and this exact map is duplicated
 * there (no shared component between the two boards - see the flexShrink
 * comment on `card` above), so an area reads as the same color on either
 * board.
 */
const AREA_COLOR: Record<FeatureArea, { fg: string; bg: string; border: string }> = {
  'Site Data': { fg: tokens.colorPaletteBlueForeground2, bg: tokens.colorPaletteBlueBackground2, border: tokens.colorPaletteBlueBorderActive },
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

function buildClaudePrompt(f: FeatureRequest, replies: readonly BoardReply[] = []): string {
  const na = '_Not specified._';
  const lines: (string | null)[] = [
    `# Feature request: ${f.title}`,
    '',
    `- **Area:** ${f.area}`,
    `- **Priority:** ${FEATURE_PRIORITY_LABELS[f.priority]}`,
    `- **Affected roles:** ${f.affected_roles.length ? f.affected_roles.join(', ') : 'Not specified'}`,
    f.submitted_by_name ? `- **Requested by:** ${f.submitted_by_name}` : null,
    '',
    '## Problem / motivation',
    f.problem,
    '',
    '## Proposed solution / desired behaviour',
    f.proposal,
    '',
    '## Current behaviour',
    f.current_behavior || na,
    '',
    '## Example scenario',
    f.examples || na,
    '',
    '## Acceptance criteria',
    f.acceptance || na,
    '',
    '## Constraints / out of scope',
    f.constraints || na,
    '',
    '## Decision notes so far',
    f.decision_note || na,
    '',
    f.attachment_count ? `_${f.attachment_count} file${f.attachment_count === 1 ? ' is' : 's are'} attached to this request on the Feature requests board._` : null,
    f.attachment_count ? '' : null,
    ...boardRepliesForPrompt(replies),
    '---',
    'Review how this works in the codebase today, raise anything ambiguous, then implement it following the repo conventions in `docs/ARCHITECTURE.md` (shared `DataTable`, `makeStyles` for styling, RBAC in `packages/shared/src/rbac.ts`, plain-SQL migrations, zod DTOs in `packages/shared/src/dto.ts`). Typecheck every workspace and build the web app before finishing. When it ships, set this feature request to "Deployed".',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** Copies a card's prompt, with its replies (fetched fresh, so the latest answers are in it). */
function copyPrompt(qc: QueryClient, f: FeatureRequest): Promise<boolean> {
  if (!f.reply_count) return copyText(buildClaudePrompt(f));
  return copyTextLater(async () => buildClaudePrompt(f, await fetchReplies(qc, '/feature-requests', f.id)));
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
  priority: FeaturePriority;
  problem: string;
  proposal: string;
  current_behavior: string;
  examples: string;
  acceptance: string;
  constraints: string;
  affected_roles: Role[];
  decision_note: string;
}

const emptyForm: FormState = {
  title: '',
  area: '',
  priority: 'medium',
  problem: '',
  proposal: '',
  current_behavior: '',
  examples: '',
  acceptance: '',
  constraints: '',
  affected_roles: [],
  decision_note: '',
};

function toForm(f: FeatureRequest): FormState {
  return {
    title: f.title,
    area: f.area,
    priority: f.priority,
    problem: f.problem,
    proposal: f.proposal,
    current_behavior: f.current_behavior ?? '',
    examples: f.examples ?? '',
    acceptance: f.acceptance ?? '',
    constraints: f.constraints ?? '',
    affected_roles: f.affected_roles ?? [],
    decision_note: f.decision_note ?? '',
  };
}

function FeatureForm({
  mode,
  admin = false,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  /** An administrator also writes the decision note; the requester edits only the request. */
  admin?: boolean;
  initial?: FeatureRequest;
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
        priority: v.priority,
        problem: v.problem.trim(),
        proposal: v.proposal.trim(),
        current_behavior: v.current_behavior.trim(),
        examples: v.examples.trim(),
        acceptance: v.acceptance.trim(),
        constraints: v.constraints.trim(),
        affected_roles: v.affected_roles,
      };
      return mode === 'create'
        ? api('/feature-requests', { method: 'POST', body: JSON.stringify(base) })
        : api(`/feature-requests/${initial!.id}`, {
            method: 'PATCH',
            body: JSON.stringify(admin ? { ...base, decision_note: v.decision_note.trim() } : base),
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
    v.problem.trim().length < 20 ||
    v.proposal.trim().length < 20;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.formSurface}>
        <DialogBody>
          <DialogTitle>{mode === 'create' ? 'New feature request' : 'Edit feature request'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              {mode === 'create' && (
                <div className={s.guide}>
                  What you write here becomes the prompt an engineer hands to Claude Code, so be
                  specific. A strong request:
                  <ul className={s.guideList}>
                    <li>states the <b>goal and the pain</b> — what's wrong or missing, and why it matters</li>
                    <li>describes the <b>desired end state</b> concretely (what the user sees / can do, and where)</li>
                    <li>gives <b>one concrete example</b> — given X, when I do Y, then Z</li>
                    <li>lists <b>acceptance criteria</b> — the checks that mean "done"</li>
                    <li>calls out <b>constraints</b> — anything that must not change or is out of scope</li>
                  </ul>
                  Keep each request to a single, coherent change — split big ideas into several.
                </div>
              )}

              <Field
                label="Title"
                required
                hint="One specific line, action-first. e.g. “Let engineers bulk-import users from CSV”, not “improve users page”."
              >
                <Input value={v.title} maxLength={160} onChange={(_, d) => set('title', d.value)} />
              </Field>

              <div className={s.formRow}>
                <Field label="Area" required hint="Which part of the product this touches.">
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
                <Field label="Priority" hint="Your view of urgency — an admin can adjust it.">
                  <Dropdown
                    selectedOptions={[v.priority]}
                    value={FEATURE_PRIORITY_LABELS[v.priority]}
                    onOptionSelect={(_, d) => set('priority', (d.optionValue as FeaturePriority) ?? 'medium')}
                  >
                    {FEATURE_PRIORITIES.map((p) => (
                      <Option key={p} value={p}>
                        {FEATURE_PRIORITY_LABELS[p]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>

              <Field
                label="Problem / motivation"
                required
                hint="What's wrong or missing today, why it matters, and who feels the pain. 2–5 sentences."
              >
                <Textarea
                  value={v.problem}
                  resize="vertical"
                  rows={3}
                  onChange={(_, d) => set('problem', d.value)}
                />
              </Field>

              <Field
                label="Proposed solution / desired behaviour"
                required
                hint="Describe the end state concretely. If you have a preferred approach say so; if not, write “open to suggestions”."
              >
                <Textarea
                  value={v.proposal}
                  resize="vertical"
                  rows={3}
                  onChange={(_, d) => set('proposal', d.value)}
                />
              </Field>

              <Field
                label="Current behaviour"
                hint="What happens today, or “doesn't exist yet”. Helps Claude find the right code."
              >
                <Textarea
                  value={v.current_behavior}
                  resize="vertical"
                  rows={2}
                  onChange={(_, d) => set('current_behavior', d.value)}
                />
              </Field>

              <Field
                label="Example scenario"
                hint="Walk through one real case with real values: “Given a site with 200 numbers, when I click Export, then I get a CSV of…”."
              >
                <Textarea
                  value={v.examples}
                  resize="vertical"
                  rows={2}
                  onChange={(_, d) => set('examples', d.value)}
                />
              </Field>

              <Field
                label="Acceptance criteria"
                hint="A short checklist of testable outcomes. Claude verifies against these before calling it done."
              >
                <Textarea
                  value={v.acceptance}
                  resize="vertical"
                  rows={3}
                  onChange={(_, d) => set('acceptance', d.value)}
                />
              </Field>

              <Field
                label="Constraints / out of scope"
                hint="Anything that must not change or stay compatible, and what is explicitly NOT part of this request."
              >
                <Textarea
                  value={v.constraints}
                  resize="vertical"
                  rows={2}
                  onChange={(_, d) => set('constraints', d.value)}
                />
              </Field>

              <Field label="Affected roles" hint="Whose experience changes. Optional.">
                <Dropdown
                  multiselect
                  placeholder="Any / not sure"
                  selectedOptions={v.affected_roles}
                  value={v.affected_roles.join(', ')}
                  onOptionSelect={(_, d) => set('affected_roles', (d.selectedOptions as Role[]) ?? [])}
                >
                  {ROLES.map((r) => (
                    <Option key={r} value={r}>
                      {r}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              {mode === 'edit' && admin && (
                <Field
                  label="Decision note"
                  hint="Why it was declined, or scheduling / triage notes. Shown on the card."
                >
                  <Textarea
                    value={v.decision_note}
                    resize="vertical"
                    rows={2}
                    onChange={(_, d) => set('decision_note', d.value)}
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
              {mode === 'create' ? 'Submit request' : 'Save changes'}
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

const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The files on a request: download any; attach when you asked for it or administer the board; remove what you attached. */
function Attachments({ f, canAttach, canRemove }: { f: FeatureRequest; canAttach: boolean; canRemove: (a: FeatureRequestAttachment) => boolean }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const key = ['feature-request-attachments', f.id];
  const list = useQuery({ queryKey: key, queryFn: () => api<FeatureRequestAttachment[]>(`/feature-requests/${f.id}/attachments`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['feature-requests'] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => {
      if (file.size > FEATURE_ATTACHMENT_MAX_BYTES) throw new ApiError(400, 'That file is too large (10 MB at most).');
      return apiUpload(`/feature-requests/${f.id}/attachments`, file);
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not attach the file.'),
  });
  const remove = useMutation({
    mutationFn: (a: FeatureRequestAttachment) => api(`/feature-requests/${f.id}/attachments/${a.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not remove the file.'),
  });
  const items = list.data ?? [];
  if (!canAttach && items.length === 0) return null;
  return (
    <div className={s.detailField}>
      <span className={s.detailLabel}>Attachments</span>
      {list.isLoading && <Spinner size="tiny" />}
      {items.map((a) => (
        <div key={a.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <AttachRegular />
          <Link
            onClick={() => apiDownload(`/feature-requests/${f.id}/attachments/${a.id}`, a.filename).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not download the file.'))}
          >
            {a.filename}
          </Link>
          <Text size={200} className={s.meta}>
            {fileSize(a.size)} · {a.uploaded_by_name ?? 'Unknown'} · {timeAgo(a.created_at)}
          </Text>
          {canRemove(a) && (
            <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Remove ${a.filename}`} disabled={remove.isPending} onClick={() => remove.mutate(a)} />
          )}
        </div>
      ))}
      {canAttach && (
        <div>
          <input
            id={`feature-attach-${f.id}`}
            type="file"
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.docx,.xlsx,.pptx,.doc,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) upload.mutate(file);
            }}
          />
          <Button size="small" icon={<AttachRegular />} disabled={upload.isPending} onClick={() => document.getElementById(`feature-attach-${f.id}`)?.click()}>
            {upload.isPending ? 'Attaching…' : 'Attach a file'}
          </Button>
        </div>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

function DetailDialog({
  f,
  canEdit,
  canAttach,
  canRemoveAttachment,
  onEdit,
  onClose,
  meId,
  canManage,
}: {
  f: FeatureRequest;
  meId: string | undefined;
  /** an administrator of the board: may delete any reply */
  canManage: boolean;
  canEdit: boolean;
  canAttach: boolean;
  canRemoveAttachment: (a: FeatureRequestAttachment) => boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const s = useStyles();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.detailSurface}>
        <DialogBody>
          <DialogTitle>{f.title}</DialogTitle>
          <DialogContent>
            <div className={s.detailBody}>
              <div className={s.tags}>
                <Badge appearance="tint" color={PRIORITY_COLOR[f.priority]} size="small">
                  {FEATURE_PRIORITY_LABELS[f.priority]}
                </Badge>
                <span
                  className={s.areaTag}
                  style={{ color: AREA_COLOR[f.area].fg, backgroundColor: AREA_COLOR[f.area].bg, borderColor: AREA_COLOR[f.area].border }}
                >
                  {f.area}
                </span>
                <span
                  className={s.areaTag}
                  style={{ color: FEATURE_STATUS_COLOR[f.status], backgroundColor: 'transparent', borderColor: FEATURE_STATUS_COLOR[f.status] }}
                >
                  {FEATURE_STATUS_LABELS[f.status]}
                </span>
              </div>
              <DetailRow
                label="Requested by"
                value={`${f.submitted_by_name ?? 'Unknown'} · ${timeAgo(f.created_at)}`}
              />
              <DetailRow
                label="Affected roles"
                value={f.affected_roles.length ? f.affected_roles.join(', ') : null}
              />
              <DetailRow label="Problem / motivation" value={f.problem} />
              <DetailRow label="Proposed solution / desired behaviour" value={f.proposal} />
              <DetailRow label="Current behaviour" value={f.current_behavior} />
              <DetailRow label="Example scenario" value={f.examples} />
              <DetailRow label="Acceptance criteria" value={f.acceptance} />
              <DetailRow label="Constraints / out of scope" value={f.constraints} />
              <DetailRow label="Decision note" value={f.decision_note} />
              <Attachments f={f} canAttach={canAttach} canRemove={canRemoveAttachment} />
              <CardReplies path="/feature-requests" cardId={f.id} meId={meId} canManage={canManage} listKey={['feature-requests']} />
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="subtle"
              icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
              onClick={async () => {
                if (await copyPrompt(qc, f)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy prompt'}
            </Button>
            {canEdit && (
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

function RequestCard({
  f,
  canManage,
  canOwn,
  onOpen,
  onEdit,
  onMove,
  onDelete,
  meId,
}: {
  meId: string | undefined;
  f: FeatureRequest;
  canManage: boolean;
  /** The requester's own request, still New: they may edit or withdraw it. */
  canOwn: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: (status: FeatureStatus) => void;
  onDelete: () => void;
}) {
  const ls = useLocalStyles();
  const s = useStyles();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyPrompt(qc, f);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Card
      className={s.card}
      style={{ borderColor: FEATURE_STATUS_COLOR[f.status] }}
      draggable={canManage}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', f.id);
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
        <div className={s.cardTitle}>{f.title}</div>
        <div className={s.tags}>
          <Badge appearance="tint" color={PRIORITY_COLOR[f.priority]} size="small">
            {FEATURE_PRIORITY_LABELS[f.priority]}
          </Badge>
          <span
            className={s.areaTag}
            style={{ color: AREA_COLOR[f.area].fg, backgroundColor: AREA_COLOR[f.area].bg, borderColor: AREA_COLOR[f.area].border }}
          >
            {f.area}
          </span>
        </div>
        {f.decision_note && <div className={s.noteClamp}>Note: {f.decision_note}</div>}
      </div>
      <div className={s.cardFoot}>
        <Text className={s.meta}>
          {f.submitted_by_name ?? 'Unknown'} · {timeAgo(f.created_at)}
          {f.attachment_count > 0 && (
            <span title={`${f.attachment_count} attached file${f.attachment_count === 1 ? '' : 's'}`}>
              {' · '}
              <AttachRegular style={{ verticalAlign: 'text-bottom' }} /> {f.attachment_count}
            </span>
          )}
          <ReplyCount cardId={f.id} count={f.reply_count} lastAt={f.last_reply_at} lastBy={f.last_reply_by} meId={meId} />
        </Text>
        <div className={ls.flexGap2}>
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
          {(canManage || canOwn) && (
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
                  {canManage && FEATURE_STATUSES.filter((st) => st !== f.status).map((st) => (
                    <MenuItem key={st} onClick={() => onMove(st)}>
                      Move to {FEATURE_STATUS_LABELS[st]}
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

export function FeatureRequests() {
  const ls = useLocalStyles();
  const s = useStyles();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const canManage = can('feature:manage');
  /** The person who asked for a feature may change or withdraw it while it is still New. */
  const isOwnNew = (f: FeatureRequest) => !!me?.id && f.submitted_by === me.id && f.status === 'new';
  const canCreate = can('feature:create');

  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; f: FeatureRequest } | null>(
    null,
  );
  const [detail, setDetail] = useState<FeatureRequest | null>(null);
  const [overCol, setOverCol] = useState<FeatureStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FeatureRequest | null>(null);
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['feature-requests'],
    queryFn: () => api<FeatureRequest[]>('/feature-requests'),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['feature-requests'] });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeatureStatus }) =>
      api(`/feature-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: invalidate,
  });
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/feature-requests/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(null);
      setDeleteError(null);
      invalidate();
    },
    onError: (e) => setDeleteError(e instanceof ApiError ? e.message : 'Could not delete the request.'),
  });

  const byStatus = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = term
      ? (list.data ?? []).filter((f) => f.title.toLowerCase().includes(term) || f.problem.toLowerCase().includes(term))
      : (list.data ?? []);
    const m = new Map<FeatureStatus, FeatureRequest[]>();
    for (const st of FEATURE_STATUSES) m.set(st, []);
    for (const f of rows) m.get(f.status)?.push(f);
    return m;
  }, [list.data, search]);

  const actions: ReactNode = canCreate ? (
    <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialog({ mode: 'create' })}>
      New feature request
    </Button>
  ) : undefined;

  return (
    <Page platform
      title="Feature requests"
      subtitle="Ideas to improve the platform. An admin moves a card to “In development” to hand it to Claude Code; it returns to “Deployed” when the change ships."
      actions={actions}
    >
      <SearchBox
        size="small"
        placeholder="Search by title or problem…"
        value={search}
        onChange={(_, d) => setSearch(d.value)}
        className={ls.maxW320Mb8}
      />
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>{(list.error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : (
        <div className={s.board}>
          {FEATURE_STATUSES.map((st) => {
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
                  const cur = (list.data ?? []).find((f) => f.id === id);
                  if (id && cur && cur.status !== st) move.mutate({ id, status: st });
                }}
              >
                <div className={s.columnHead}>
                  <span className={s.columnTitle}>
                    <span className={s.columnDot} style={{ backgroundColor: FEATURE_STATUS_COLOR[st] }} />
                    {FEATURE_STATUS_LABELS[st]}
                  </span>
                  <Badge appearance="tint" color="informative" size="small">
                    {items.length}
                  </Badge>
                </div>
                <div className={s.columnBody}>
                  {items.length === 0 ? (
                    <div className={s.empty}>Nothing here.</div>
                  ) : (
                    items.map((f) => (
                      <RequestCard
                        key={f.id}
                        meId={me?.id}
                        f={f}
                        canManage={canManage}
                        canOwn={isOwnNew(f)}
                        onOpen={() => setDetail(f)}
                        onEdit={() => setDialog({ mode: 'edit', f })}
                        onMove={(status) => move.mutate({ id: f.id, status })}
                        onDelete={() => setConfirmDelete(f)}
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
          f={(list.data ?? []).find((x) => x.id === detail.id) ?? detail}
          canEdit={canManage || isOwnNew((list.data ?? []).find((x) => x.id === detail.id) ?? detail)}
          canAttach={canManage || (!!me?.id && detail.submitted_by === me.id)}
          canRemoveAttachment={(a) => canManage || (!!me?.id && a.uploaded_by === me.id)}
          onEdit={() => setDialog({ mode: 'edit', f: detail })}
          onClose={() => setDetail(null)}
          meId={me?.id}
          canManage={canManage}
        />
      )}

      {dialog?.mode === 'create' && (
        <FeatureForm mode="create" onClose={() => setDialog(null)} onSaved={invalidate} />
      )}
      {dialog?.mode === 'edit' && (
        <FeatureForm
          mode="edit"
          admin={canManage}
          initial={dialog.f}
          onClose={() => setDialog(null)}
          onSaved={invalidate}
        />
      )}

      {confirmDelete && (
        <Dialog open onOpenChange={(_, d) => !d.open && (setConfirmDelete(null), setDeleteError(null))}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete this feature request?</DialogTitle>
              <DialogContent>
                “{confirmDelete.title}” will be permanently removed. This cannot be undone.
                {deleteError && (
                  <MessageBar intent="error">
                    <MessageBarBody>{deleteError}</MessageBarBody>
                  </MessageBar>
                )}
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  className={ls.dangerFill}
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
